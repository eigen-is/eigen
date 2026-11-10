// The calendar part of a Home: calendars and their events in one SQLite database. Each event is stored as the
// iCalendar file it came from, and every other column is read from that file. The class is the one door to that data
// for callers such as the REST routes, the CalDAV server and the invitation code. It also checks names and colors.

import { CALENDAR_NAME_MAX_LENGTH, DEFAULT_CALENDAR_COLOR } from '@workspace/lib/constants/calendar';
import { EIGEN_ACCENT_COLORS_SHUFFLED, isHexColor } from '@workspace/lib/constants/colors';
import type {
    Attendee,
    CalendarEvent,
    CalendarEventOccurrence,
    CalendarItem,
    CalendarShare,
    SharedCalendar,
} from '@workspace/lib/types/calendar';
import { SSEventType } from '@workspace/lib/types/sse';
import type { ImportCountsResult } from '@workspace/lib/types/transfer';
import { and, eq, getTableColumns, isNull, sql } from 'drizzle-orm';
import type { BunSQLiteDatabase } from 'drizzle-orm/bun-sqlite';
import { Semaphore } from '../../utils/semaphore';
import { enforceHomeDataQuota } from '../config/enforcement';
import { PATHS } from '../config/paths';
import type { DeleteResourceResult, ManagedDatabase, PutResourceResult, ResourcePreconditions } from '../core';
import { ApiError, newSyncGen } from '../core';
import type { Home } from '../home';
import { atHome } from '../home';
import type { EventPatch, Revision } from '../ical/ical-component';
import type { ParsedEvent } from '../ical/ical-parse';
import type { User } from '../user';
import type { PutResourceOptions, ResourceRow } from './dav-store';
import * as davStore from './dav-store';
import { CALENDAR_DB_CONFIG } from './db-config';
import * as events from './events';
import * as invitations from './invitations';
import { dbCalendarToCalendarItem, toEvent } from './mappers';
import * as occurrences from './occurrences';
import type { CalendarCollection, PreparedResource, PurgedResource, Tx } from './resource-store';
import { EVENT_MAX_BYTES, resourceBytes, sanitizeCalendarId } from './resource-store';
import * as schema from './schema';
import { notifySharedCalendarUsers, propagateCalendarShare } from './share-propagation';
import * as shares from './shares';
import { buildCalendarEvent } from './sse-events';
import { exportEvents, importEvents } from './transfer';
import type { CreateEventArgs, InvitationLink } from './types';

export class Calendar {
    private managedDb!: ManagedDatabase<typeof schema>;
    public db!: BunSQLiteDatabase<typeof schema>;
    public home: Home;

    // For the async gaps between a write's check and its commit, such as the quota check, so a racing If-Match
    // PUT loses inside the lock.
    public writeLock = new Semaphore(1);

    // A running total, since a SUM per metered write makes an N-event device sync O(N²). Each delta is applied
    // after its commit, so a rollback moves nothing.
    private eventsBytes = 0;

    private meteredIngest = false;

    public constructor(home: Home) {
        this.home = home;
    }

    public async init(): Promise<void> {
        this.managedDb = await this.home.getLocalDatabase(CALENDAR_DB_CONFIG, PATHS.CALENDAR.DB);
        this.db = this.managedDb.db;

        // Seeded once here, then moved by delta at each commit and purge.
        this.eventsBytes = this.db
            .select({ total: sql<number>`COALESCE(SUM(${resourceBytes}), 0)` })
            .from(schema.resources)
            .all()[0].total;

        if (this.db.select({ id: schema.calendars.id }).from(schema.calendars).all().length === 0) {
            await this.createCalendar({
                name: this.home.user.name || 'Personal',
                color: EIGEN_ACCENT_COLORS_SHUFFLED[0].value,
                isDefault: true,
            });
        }

        // A home nobody registered stays unmetered: its quota lookup would boot a second Home over this very database.
        this.meteredIngest = atHome(this.home.user.id);
    }

    // Never locks: a quota check reaches it from inside the write lock.
    public async size(): Promise<number> {
        return this.eventsBytes;
    }

    public async destruct(): Promise<void> {
        if (this.managedDb) {
            await this.managedDb.close();
        }
    }

    // --- Seams for the calendar's own modules ---

    public calendarRow(id: string): typeof schema.calendars.$inferSelect | null {
        return this.db.select().from(schema.calendars).where(eq(schema.calendars.id, id)).get() ?? null;
    }

    public bumpCtag(tx: Tx, calendarId: string): number {
        return tx
            .update(schema.calendars)
            .set({ ctag: sql`${schema.calendars.ctag} + 1`, updatedAt: sql`unixepoch()` })
            .where(eq(schema.calendars.id, calendarId))
            .returning({ ctag: schema.calendars.ctag })
            .get().ctag;
    }

    public tombstone(tx: Tx, calendarId: string, uri: string, ctag: number): void {
        tx.insert(schema.resourceTombstones)
            .values({ calendarId, uri, deletedAtCtag: ctag })
            .onConflictDoUpdate({
                target: [schema.resourceTombstones.calendarId, schema.resourceTombstones.uri],
                set: { deletedAtCtag: ctag },
            })
            .run();
    }

    // Caller holds the write lock. `creditBytes` is the stored resource this one replaces, or a shrinking rewrite
    // would be refused on a quota its own bytes already hold.
    public async writeResource(opts: {
        calendarId: string;
        uri: string;
        prepared: PreparedResource;
        creditBytes: number;
    }): Promise<void> {
        const { calendarId, uri, prepared } = opts;
        const { id, bytes } = prepared;
        if (bytes.byteLength > EVENT_MAX_BYTES) throw new ApiError(413, 'Event is too large');
        if (this.meteredIngest) {
            await enforceHomeDataQuota(this.home.user.id, bytes.byteLength, opts.creditBytes);
        }
        // One transaction, so the ctag bump, the blob, the event rows and the tombstone clear settle together.
        const delta = this.db.transaction((tx) => {
            const previous = tx
                .select({ size: resourceBytes })
                .from(schema.resources)
                .where(eq(schema.resources.id, id))
                .get();
            const row = {
                uri,
                uid: prepared.uid,
                ics: bytes,
                etag: prepared.etag,
                resourceCtag: this.bumpCtag(tx, calendarId),
                hasUnindexedRecurrence: prepared.hasUnindexedRecurrence,
            };
            tx.insert(schema.resources)
                .values({ id, calendarId, ...row })
                .onConflictDoUpdate({ target: schema.resources.id, set: row })
                .run();
            // The projected rows are replaced wholesale, so an event a rewrite no longer carries leaves no row behind.
            tx.delete(schema.events).where(eq(schema.events.resourceId, id)).run();
            for (const event of prepared.rows) tx.insert(schema.events).values(event).run();
            // A resource at this uri is alive, so one written over a deleted name drops its stale removal.
            tx.delete(schema.resourceTombstones)
                .where(
                    and(eq(schema.resourceTombstones.calendarId, calendarId), eq(schema.resourceTombstones.uri, uri)),
                )
                .run();
            return bytes.byteLength - (previous?.size ?? 0);
        });
        this.eventsBytes += delta;
    }

    // Callers hold the write lock and have already run their own guards (preconditions, the linked-copy rule).
    public async purgeResource(row: Pick<PurgedResource, 'id' | 'calendarId' | 'uri'>): Promise<void> {
        const removed = this.db.transaction((tx) => {
            const { size } = tx
                .select({ size: resourceBytes })
                .from(schema.resources)
                .where(eq(schema.resources.id, row.id))
                .all()[0];
            const ctag = this.bumpCtag(tx, row.calendarId);
            tx.delete(schema.resources).where(eq(schema.resources.id, row.id)).run();
            this.tombstone(tx, row.calendarId, row.uri, ctag);
            return size;
        });
        this.eventsBytes -= removed;
    }

    // --- Calendars ---

    public async getCalendars(): Promise<CalendarItem[]> {
        return this.db.select().from(schema.calendars).all().map(dbCalendarToCalendarItem);
    }

    public async getCalendarById(id: string): Promise<CalendarItem | null> {
        return this.calendarById(id);
    }

    // Synchronous for the paths that may not await, because a transaction commits at its first await.
    private calendarById(id: string): CalendarItem | null {
        const row = this.calendarRow(id);
        return row ? dbCalendarToCalendarItem(row) : null;
    }

    // The ctag and the generation a recreated calendar rotates make the sync token.
    public async getCollections(): Promise<CalendarCollection[]> {
        return this.db
            .select()
            .from(schema.calendars)
            .all()
            .map((row) => ({ ...dbCalendarToCalendarItem(row), syncGen: row.syncGen }));
    }

    public async getCollection(id: string): Promise<CalendarCollection | null> {
        const row = this.calendarRow(id);
        return row ? { ...dbCalendarToCalendarItem(row), syncGen: row.syncGen } : null;
    }

    public async createCalendar(input: {
        name: string;
        color?: string;
        id?: string;
        isDefault?: boolean;
    }): Promise<CalendarItem> {
        validateCalendarProps(input);
        const id = input.id ?? crypto.randomUUID();
        if (sanitizeCalendarId(id) !== id) throw new ApiError(400, 'Invalid calendar name');

        // Inside the lock, so two creates of one id cannot both read the name as free.
        const created = await this.writeLock.run(async () => {
            if (this.calendarIdTaken(id)) throw new ApiError(409, 'Calendar already exists');

            const row = this.db
                .insert(schema.calendars)
                .values({
                    id,
                    name: input.name.trim(),
                    color: input.color ?? DEFAULT_CALENDAR_COLOR,
                    isDefault: input.isDefault ?? false,
                    ctag: 0,
                    // A calendar recreated at a deleted id must never reissue a generation a client has seen.
                    syncGen: newSyncGen(),
                    shares: null,
                })
                .returning()
                .get();
            return dbCalendarToCalendarItem(row);
        });

        this.home.broadcast(buildCalendarEvent(SSEventType.CALENDAR_CREATED, this.home.user.id));
        return created;
    }

    private calendarIdTaken(id: string): boolean {
        return !!this.db
            .select({ id: schema.calendars.id })
            .from(schema.calendars)
            .where(eq(schema.calendars.id, id))
            .get();
    }

    public async updateCalendar(
        id: string,
        input: {
            name?: string;
            color?: string;
            visible?: boolean;
            shares?: CalendarShare[] | null;
        },
    ): Promise<CalendarItem> {
        validateCalendarProps(input);
        const existing = this.calendarById(id);
        if (!existing) throw new ApiError(404, 'Calendar not found');

        const oldShares = existing.shares;

        const updated = dbCalendarToCalendarItem(
            this.db
                .update(schema.calendars)
                .set({
                    name: input.name !== undefined ? input.name.trim() : existing.name,
                    color: input.color ?? existing.color,
                    visible: input.visible ?? existing.visible,
                    shares: input.shares !== undefined ? input.shares : existing.shares,
                    updatedAt: sql`unixepoch()`,
                })
                .where(eq(schema.calendars.id, id))
                .returning()
                .get(),
        );

        if (input.shares !== undefined) await propagateCalendarShare(this.home, updated, oldShares);

        this.home.broadcast(buildCalendarEvent(SSEventType.CALENDAR_UPDATED, this.home.user.id));
        return updated;
    }

    public async deleteCalendar(id: string): Promise<void> {
        const existing = this.calendarById(id);
        if (!existing) throw new ApiError(404, 'Calendar not found');
        if (existing.isDefault) throw new ApiError(400, 'Cannot delete default calendar');

        // Outside the lock: two Homes each deleting a calendar shared with the other would be a two-lock cycle.
        if (existing.shares?.length) {
            await propagateCalendarShare(this.home, { ...existing, shares: [] }, existing.shares);
        }

        await this.writeLock.run(async () => {
            const removed = this.db.transaction((tx) => {
                const { total } = tx
                    .select({ total: sql<number>`COALESCE(SUM(${resourceBytes}), 0)` })
                    .from(schema.resources)
                    .where(eq(schema.resources.calendarId, id))
                    .all()[0];
                // The resources and their event rows go with the row, by cascade.
                tx.delete(schema.calendars).where(eq(schema.calendars.id, id)).run();
                // No cascade reaches these: a calendar recreated at this id would inherit the 404s.
                tx.delete(schema.resourceTombstones).where(eq(schema.resourceTombstones.calendarId, id)).run();
                return total;
            });
            this.eventsBytes -= removed;
        });

        this.home.broadcast(buildCalendarEvent(SSEventType.CALENDAR_DELETED, this.home.user.id));
    }

    // --- Resources ---

    public async listResources(calendarId: string): Promise<ResourceRow[]> {
        return davStore.listResources(this, calendarId);
    }

    public async getResourceMeta(calendarId: string, uri: string): Promise<ResourceRow | null> {
        return davStore.getResourceMeta(this, calendarId, uri);
    }

    public async getResourcesByUris(calendarId: string, uris: string[]): Promise<ResourceRow[]> {
        return davStore.getResourcesByUris(this, calendarId, uris);
    }

    public async getChangedResourcesSince(calendarId: string, sinceCtag: number): Promise<ResourceRow[]> {
        return davStore.getChangedResourcesSince(this, calendarId, sinceCtag);
    }

    public async getDeletedResourcesSince(calendarId: string, sinceCtag: number): Promise<{ uri: string }[]> {
        return davStore.getDeletedResourcesSince(this, calendarId, sinceCtag);
    }

    public async getResource(calendarId: string, uri: string): Promise<{ bytes: Uint8Array; etag: string } | null> {
        return davStore.getResource(this, calendarId, uri);
    }

    public async putResource(
        calendarId: string,
        uri: string,
        body: string,
        options: PutResourceOptions,
    ): Promise<PutResourceResult> {
        const result = await davStore.putResource(this, calendarId, uri, body, options);
        if (result.ok && !result.unchanged) {
            this.announce(
                result.created ? SSEventType.CALENDAR_EVENT_CREATED : SSEventType.CALENDAR_EVENT_UPDATED,
                calendarId,
            );
        }
        return result;
    }

    public async deleteResource(
        calendarId: string,
        uri: string,
        pre: Pick<ResourcePreconditions, 'ifMatch'>,
    ): Promise<DeleteResourceResult> {
        const result = await davStore.deleteResource(this, calendarId, uri, pre);
        if (result.ok) this.announce(SSEventType.CALENDAR_EVENT_DELETED, calendarId);
        return result;
    }

    // Plus every resource the index cannot expand: a stripped rule or an RDATE still has occurrences to sync.
    public async getResourcesInRange(calendarId: string, from: Date, to: Date): Promise<ResourceRow[]> {
        const matched = await occurrences.getResourceUrisInRange(this, calendarId, from, to);
        return davStore.getResourcesInRange(this, calendarId, [...matched]);
    }

    // --- Events (reads) ---

    public joinedEvents() {
        return this.db
            .select({
                events: getTableColumns(schema.events),
                resources: { uri: schema.resources.uri, etag: schema.resources.etag },
            })
            .from(schema.events)
            .innerJoin(schema.resources, eq(schema.events.resourceId, schema.resources.id));
    }

    public async getEventById(calendarId: string, id: string): Promise<CalendarEvent | null> {
        const row = this.joinedEvents()
            .where(and(eq(schema.events.calendarId, calendarId), eq(schema.events.id, id)))
            .get();
        return row ? toEvent(row) : null;
    }

    public async getEventsByUid(uid: string): Promise<CalendarEvent[]> {
        return this.joinedEvents().where(eq(schema.events.uid, uid)).all().map(toEvent);
    }

    public async getEventsInRange(from: Date, to: Date, calendarId?: string): Promise<CalendarEventOccurrence[]> {
        return occurrences.getEventsInRange(this, from, to, calendarId);
    }

    public async getEventsWithAttendee(email: string): Promise<CalendarEvent[]> {
        return this.joinedEvents()
            .where(isNull(schema.events.organizerEventId))
            .all()
            .map(toEvent)
            .filter((e) => e.data?.attendees?.some((a) => a.email.toLowerCase() === email.toLowerCase()));
    }

    // --- Announcements ---

    // An announcement reaches the owner's own tabs and every Home the calendar is shared with.
    public announce(type: Parameters<typeof buildCalendarEvent>[0], calendarId: string): void {
        const sseEvent = buildCalendarEvent(type, this.home.user.id);
        this.home.broadcast(sseEvent);
        const cal = this.calendarById(calendarId);
        if (cal) notifySharedCalendarUsers(this.home, cal, sseEvent).catch(console.error);
    }

    // --- Events (writes) ---

    public async createEvent(calendarId: string, input: CreateEventArgs, user?: User): Promise<CalendarEvent> {
        return events.createEvent(this, calendarId, input, user);
    }

    public async updateEvent(
        calendarId: string,
        id: string,
        input: EventPatch,
        user?: User,
        expectedEtag?: string,
    ): Promise<CalendarEvent> {
        return events.updateEvent(this, calendarId, id, input, user, expectedEtag);
    }

    public async deleteEvent(calendarId: string, id: string, user?: User, expectedEtag?: string): Promise<void> {
        return events.deleteEvent(this, calendarId, id, user, expectedEtag);
    }

    public async moveEvent(
        calendarId: string,
        id: string,
        targetCalendarId: string,
        expectedEtag?: string,
    ): Promise<CalendarEvent> {
        return events.moveEvent(this, calendarId, id, targetCalendarId, expectedEtag);
    }

    // A whole `.ics` into one calendar of this Home, each series written through the store a device sync takes.
    public async importEvents(calendarId: string, bytes: Uint8Array): Promise<ImportCountsResult> {
        return importEvents(this, calendarId, bytes);
    }

    // One calendar, or the series `ids` name, as one `.ics`.
    public async exportEvents(calendarId: string, ids?: string[]): Promise<string> {
        return exportEvents(this, calendarId, ids);
    }

    // --- Shared calendars ---

    public async getSharedCalendars(): Promise<SharedCalendar[]> {
        return shares.getSharedCalendars(this);
    }

    public async updateSharedCalendar(
        id: string,
        input: { color?: string | null; visible?: boolean },
    ): Promise<SharedCalendar> {
        return shares.updateSharedCalendar(this, id, input);
    }

    public async deleteSharedCalendar(id: string): Promise<void> {
        shares.deleteSharedCalendar(this, id);
    }

    public async receiveShare(
        ownerUserId: string,
        calendarId: string,
        calendarName: string,
        permission: CalendarShare['permission'],
        actorEmail?: string,
        actorName?: string,
    ): Promise<void> {
        shares.receiveShare(this, ownerUserId, calendarId, calendarName, permission, actorEmail, actorName);
    }

    public async removeShare(
        ownerUserId: string,
        calendarId: string,
        actorEmail?: string,
        actorName?: string,
    ): Promise<void> {
        shares.removeShare(this, ownerUserId, calendarId, actorEmail, actorName);
    }

    public async ensureSharedEntry(
        ownerUserId: string,
        calendarId: string,
        calendarName: string,
        permission: CalendarShare['permission'],
    ): Promise<void> {
        shares.ensureSharedEntry(this, ownerUserId, calendarId, calendarName, permission);
    }

    public async removeSharedEntriesForOwner(ownerUserId: string): Promise<void> {
        shares.removeSharedEntriesForOwner(this, ownerUserId);
    }

    public async getSharedWith(
        userEmail: string,
        teamIds: string[],
    ): Promise<{ calendarId: string; name: string; color: string; permission: CalendarShare['permission'] }[]> {
        return shares.getSharedWith(this, userEmail, teamIds);
    }

    public async checkPermission(
        calendarId: string,
        userEmail: string,
        teamIds: string[],
    ): Promise<CalendarShare['permission'] | null> {
        return shares.checkPermission(this, calendarId, userEmail, teamIds);
    }

    // --- Invitations ---

    public async receiveRequest(requested: readonly ParsedEvent[], link: InvitationLink): Promise<void> {
        return invitations.receiveRequest(this, requested, link);
    }

    public async cancelInvitationOccurrence(
        orgEventId: string,
        orgUserId: string,
        recurrenceDate: string,
        recurrenceInstant: Date | null | undefined,
        revision: Revision,
    ): Promise<void> {
        return invitations.cancelInvitationOccurrence(
            this,
            orgEventId,
            orgUserId,
            recurrenceDate,
            recurrenceInstant,
            revision,
        );
    }

    public async removeInvitation(orgEventId: string, orgUserId: string): Promise<void> {
        return invitations.removeInvitation(this, orgEventId, orgUserId);
    }

    public async receiveAttendeeStatus(eventId: string, email: string, status: Attendee['status']): Promise<void> {
        return invitations.receiveAttendeeStatus(this, eventId, email, status);
    }

    public async receiveRsvpForOccurrence(
        eventId: string,
        email: string,
        status: Attendee['status'],
        recurrenceDate: string,
        recurrenceInstant?: Date | null,
        restoreCancelled = true,
    ): Promise<void> {
        return invitations.receiveRsvpForOccurrence(
            this,
            eventId,
            email,
            status,
            recurrenceDate,
            recurrenceInstant,
            restoreCancelled,
        );
    }

    public async rsvp(
        eventId: string,
        user: User,
        input: {
            status: Attendee['status'];
            scope?: 'this' | 'this-and-following' | 'all';
            recurrenceDate?: string;
            remove?: boolean;
        },
    ): Promise<void> {
        return invitations.rsvp(this, eventId, user, input);
    }
}

// The one rule for what a calendar may be called and colored: REST, MKCALENDAR and PROPPATCH all land here.
function validateCalendarProps(props: { name?: string; color?: string }): void {
    if (props.name !== undefined && props.name.trim().length > CALENDAR_NAME_MAX_LENGTH) {
        throw new ApiError(400, `Calendar name is longer than ${CALENDAR_NAME_MAX_LENGTH} characters`);
    }
    // Apple writes the eight-digit form, so all three hex lengths are valid.
    if (props.color !== undefined && !isHexColor(props.color, [3, 6, 8])) {
        throw new ApiError(400, 'Calendar color must be a hex color');
    }
}
