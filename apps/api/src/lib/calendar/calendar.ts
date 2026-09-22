import { randomUUID } from 'node:crypto';
import { CALENDAR_NAME_MAX_LENGTH, DEFAULT_CALENDAR_COLOR } from '@workspace/lib/constants/calendar';
import { EIGEN_ACCENT_COLORS_SHUFFLED } from '@workspace/lib/constants/colors';
import type {
    Attendee,
    CalendarEvent,
    CalendarEventOccurrence,
    CalendarItem,
    CalendarShare,
    SharedCalendar,
} from '@workspace/lib/types/calendar';
import { type SSEvent, SSEventType } from '@workspace/lib/types/sse';
import type { ImportCountsResult } from '@workspace/lib/types/transfer';
import { and, eq, getTableColumns, isNull, sql } from 'drizzle-orm';
import type { BunSQLiteDatabase } from 'drizzle-orm/bun-sqlite';
import { Semaphore } from '../../utils/semaphore';
import {
    ApiError,
    BroadcastBatch,
    computeResourceEtag,
    newSyncGen,
    normalizeResourceUri,
    PATHS,
    type PutResourceResult,
} from '../core';
import type { DeleteResourceResult, ManagedDatabase } from '../core/';
import type { Home } from '../home';
import { atHome } from '../home';
import { parseResource } from '../ical';
import type { EventPatch, Revision } from '../ical/ical-component';
import type { ParsedEvent } from '../ical/ical-parse';
import type { User } from '../user';
import type { PutResourceOptions, ResourceCommit, ResourceRow } from './dav-store';
import * as store from './dav-store';
import { CALENDAR_DB_CONFIG } from './db-config';
import * as events from './events';
import * as invitations from './invitations';
import { dbCalendarToCalendarItem, toEvent } from './mappers';
import * as occurrences from './occurrences';
import type { CalendarCollection, Tx } from './resource-store';
import { indexResource, resourceBytes, sanitizeCalendarId } from './resource-store';
import * as schema from './schema';
import { notifySharedCalendarUsers, propagateCalendarShare } from './share-propagation';
import * as shares from './shares';
import { buildCalendarEvent, buildEventsChangedEvent } from './sse-events';
import { exportEvents, importEvents } from './transfer';

import type { CreateEventArgs, InvitationUpdatePayload, ReceiveInvitationPayload } from './types';

function getCalendarDatabase(home: Home): Promise<ManagedDatabase<typeof schema>> {
    return home.getLocalDatabase(CALENDAR_DB_CONFIG, PATHS.CALENDAR.DB);
}

// Apple writes the eight-digit form, so all three hex lengths are valid.
const CALENDAR_COLOR = /^#(?:[0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

// The one rule for what a calendar may be called and colored: REST, MKCALENDAR and PROPPATCH all land here.
function validateCalendarProps(props: { name?: string; color?: string }): void {
    if (props.name !== undefined && props.name.trim().length > CALENDAR_NAME_MAX_LENGTH) {
        throw new ApiError(400, `Calendar name is longer than ${CALENDAR_NAME_MAX_LENGTH} characters`);
    }
    if (props.color !== undefined && !CALENDAR_COLOR.test(props.color)) {
        throw new ApiError(400, 'Calendar color must be a hex color');
    }
}

export class Calendar {
    private managedDb!: ManagedDatabase<typeof schema>;
    db!: BunSQLiteDatabase<typeof schema>;
    home: Home;

    // bun:sqlite makes a transaction atomic and serial by itself, but a write path holds async gaps between
    // its check and its commit (the quota check, an invitation fan-out), and a racing If-Match PUT must lose
    // inside the lock, not after it.
    writeLock = new Semaphore(1);

    // Running total so size() answers from memory: a SUM per metered write makes an N-event device sync O(N²).
    eventsBytes = 0;

    // Whether resource writes are quota-metered — see the assignment in init() for what turns it on.
    meteredIngest = false;

    // Bulk writes in flight; while any runs, per-resource events are held and the last one out closes them.
    private readonly batch = new BroadcastBatch(() => this.flushHeldAnnouncements());

    // Which calendars the held announcements were for, so the batched event reaches everybody they would.
    private readonly heldCalendars = new Set<string>();

    constructor(home: Home) {
        this.home = home;
    }

    public async init(): Promise<void> {
        this.managedDb = await getCalendarDatabase(this.home);
        this.db = this.managedDb.db;

        // Seeded once here, then moved by delta at each commit and purge.
        this.eventsBytes = this.db
            .select({ total: sql<number>`COALESCE(SUM(${resourceBytes}), 0)` })
            .from(schema.resources)
            .get()!.total;

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

    async destruct(): Promise<void> {
        if (this.managedDb) {
            await this.managedDb.close();
        }
    }

    // --- Seams used by calendar/*.ts ---

    calendarRow(id: string): typeof schema.calendars.$inferSelect | null {
        return this.db.select().from(schema.calendars).where(eq(schema.calendars.id, id)).get() ?? null;
    }

    bumpCtag(tx: Tx, calendarId: string): number {
        tx.update(schema.calendars)
            .set({ ctag: sql`${schema.calendars.ctag} + 1`, updatedAt: sql`unixepoch()` })
            .where(eq(schema.calendars.id, calendarId))
            .run();
        return tx
            .select({ ctag: schema.calendars.ctag })
            .from(schema.calendars)
            .where(eq(schema.calendars.id, calendarId))
            .get()!.ctag;
    }

    tombstone(tx: Tx, calendarId: string, uri: string, ctag: number): void {
        tx.insert(schema.resourceTombstones)
            .values({ calendarId, uri, deletedAtCtag: ctag })
            .onConflictDoUpdate({
                target: [schema.resourceTombstones.calendarId, schema.resourceTombstones.uri],
                set: { deletedAtCtag: ctag },
            })
            .run();
    }

    // One transaction, so the ctag bump, the blob, the event rows and the tombstone clear settle together.
    commitResource(commit: ResourceCommit): void {
        const { rows, ...resource } = commit;
        let delta = 0;
        this.db.transaction((tx) => {
            // Read inside the transaction, applied outside it: a rollback would otherwise leave the delta applied.
            const previous = tx
                .select({ size: resourceBytes })
                .from(schema.resources)
                .where(eq(schema.resources.id, commit.id))
                .get();
            delta = commit.ics.byteLength - (previous?.size ?? 0);
            indexResource(tx, { ...resource, resourceCtag: this.bumpCtag(tx, commit.calendarId) }, rows);
        });
        this.eventsBytes += delta;
    }

    // Callers hold the write lock and have already run their own guards (preconditions, the linked-copy rule).
    async purgeResource(row: { id: string; calendarId: string; uri: string }): Promise<void> {
        let removed = 0;
        this.db.transaction((tx) => {
            // Read inside the transaction, applied outside it: a rollback would otherwise leave the delta applied.
            removed = tx
                .select({ size: resourceBytes })
                .from(schema.resources)
                .where(eq(schema.resources.id, row.id))
                .get()!.size;
            const ctag = this.bumpCtag(tx, row.calendarId);
            tx.delete(schema.resources).where(eq(schema.resources.id, row.id)).run();
            this.tombstone(tx, row.calendarId, row.uri, ctag);
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

    // The sync read behind getCalendarById, for the paths that may not await — a transaction commits at the first one.
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
        const id = input.id ?? randomUUID();
        if (sanitizeCalendarId(id) !== id) throw new ApiError(400, 'Invalid calendar name');

        // Inside the lock, so two creates of one id cannot both read the name as free.
        const created = await this.writeLock.run(async () => {
            if (this.calendarIdTaken(id)) throw new ApiError(409, 'Calendar already exists');

            this.db
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
                .run();
            return this.calendarById(id)!;
        });

        this.home.broadcast(buildCalendarEvent(SSEventType.CALENDAR_CREATED, this.home.user.id));
        return created;
    }

    calendarIdTaken(id: string): boolean {
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

        this.db
            .update(schema.calendars)
            .set({
                name: input.name !== undefined ? input.name.trim() : existing.name,
                color: input.color !== undefined ? input.color : existing.color,
                visible: input.visible !== undefined ? input.visible : existing.visible,
                shares: input.shares !== undefined ? input.shares : existing.shares,
                updatedAt: sql`unixepoch()`,
            })
            .where(eq(schema.calendars.id, id))
            .run();

        if (input.shares !== undefined) {
            const updated = this.calendarById(id)!;
            await propagateCalendarShare(this.home, updated, oldShares);
        }

        this.home.broadcast(buildCalendarEvent(SSEventType.CALENDAR_UPDATED, this.home.user.id));
        return this.calendarById(id)!;
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
            let removed = 0;
            this.db.transaction((tx) => {
                // Read inside the transaction, applied outside it: a rollback would otherwise leave the delta applied.
                removed = tx
                    .select({ total: sql<number>`COALESCE(SUM(${resourceBytes}), 0)` })
                    .from(schema.resources)
                    .where(eq(schema.resources.calendarId, id))
                    .get()!.total;
                // The resources and their event rows go with the row, by cascade.
                tx.delete(schema.calendars).where(eq(schema.calendars.id, id)).run();
                // No cascade reaches these: a calendar recreated at this id would inherit the 404s.
                tx.delete(schema.resourceTombstones).where(eq(schema.resourceTombstones.calendarId, id)).run();
            });
            this.eventsBytes -= removed;
        });

        this.home.broadcast(buildCalendarEvent(SSEventType.CALENDAR_DELETED, this.home.user.id));
    }

    // --- Resources (the DAV store facade — implementation in calendar/dav-store.ts) ---

    public async listResources(calendarId: string): Promise<ResourceRow[]> {
        return store.listResources(this, calendarId);
    }

    public async getResourceMeta(calendarId: string, uri: string): Promise<ResourceRow | null> {
        return store.getResourceMeta(this, calendarId, uri);
    }

    public async getResourcesByUris(calendarId: string, uris: string[]): Promise<ResourceRow[]> {
        return store.getResourcesByUris(this, calendarId, uris);
    }

    public async getChangedResourcesSince(calendarId: string, sinceCtag: number): Promise<ResourceRow[]> {
        return store.getChangedResourcesSince(this, calendarId, sinceCtag);
    }

    public async getDeletedResourcesSince(calendarId: string, sinceCtag: number): Promise<{ uri: string }[]> {
        return store.getDeletedResourcesSince(this, calendarId, sinceCtag);
    }

    public async getResource(calendarId: string, uri: string): Promise<{ bytes: Uint8Array; etag: string } | null> {
        return store.getResource(this, calendarId, uri);
    }

    public async putResource(
        calendarId: string,
        uri: string,
        body: string,
        options: PutResourceOptions,
    ): Promise<PutResourceResult> {
        const ctagBefore = this.calendarRow(calendarId)?.ctag;
        const result = await store.putResource(this, calendarId, uri, body, options);
        // A PUT of what is already stored commits nothing, so there is nothing to tell the clients about.
        if (result.ok && this.calendarRow(calendarId)?.ctag !== ctagBefore) {
            this.announce(
                calendarId,
                result.created ? SSEventType.CALENDAR_EVENT_CREATED : SSEventType.CALENDAR_EVENT_UPDATED,
            );
        }
        return result;
    }

    public async deleteResource(
        calendarId: string,
        uri: string,
        pre: { ifMatch: string | null },
    ): Promise<DeleteResourceResult> {
        const result = await store.deleteResource(this, calendarId, uri, pre);
        if (result.ok) this.announce(calendarId, SSEventType.CALENDAR_EVENT_DELETED);
        return result;
    }

    // Plus every resource the index cannot expand: a stripped rule or an RDATE still has occurrences to sync.
    public async getResourcesInRange(calendarId: string, from: Date, to: Date): Promise<ResourceRow[]> {
        const matched = await occurrences.getResourceUrisInRange(this, calendarId, from, to);
        return store.getResourcesInRange(this, calendarId, [...matched]);
    }

    // --- Events (reads) ---

    joinedEvents() {
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

    public async getEventByUri(calendarId: string, uri: string): Promise<CalendarEvent | null> {
        const row = this.joinedEvents()
            .where(
                and(eq(schema.resources.calendarId, calendarId), eq(schema.resources.uri, normalizeResourceUri(uri))),
            )
            .all()
            .find((joined) => joined.events.parentEventId === null);
        return row ? toEvent(row) : null;
    }

    public async getRawEvents(calendarId: string): Promise<CalendarEvent[]> {
        return this.joinedEvents().where(eq(schema.events.calendarId, calendarId)).all().map(toEvent);
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

    // The blob is the truth, so every projected column and every event row come back from it. Untouched, because
    // no blob carries them: the resource and calendar ctags, the generation, the tombstones and the share grants.
    public rebuildProjection(): void {
        const rows = this.db
            .select({
                id: schema.resources.id,
                calendarId: schema.resources.calendarId,
                ics: schema.resources.ics,
            })
            .from(schema.resources)
            .all();
        this.db.transaction((tx) => {
            for (const row of rows) {
                const resource = parseResource(new TextDecoder().decode(row.ics));
                const projection = store.projectRows(row.calendarId, row.id, resource);
                tx.update(schema.resources)
                    .set({
                        uid: store.uidOfResource(resource),
                        etag: computeResourceEtag(row.ics),
                        hasUnindexedRecurrence: projection.hasUnindexedRecurrence,
                    })
                    .where(eq(schema.resources.id, row.id))
                    .run();
                tx.delete(schema.events).where(eq(schema.events.resourceId, row.id)).run();
                for (const event of projection.rows) tx.insert(schema.events).values(event).run();
            }
        });
    }

    // --- Announcements ---

    announce(calendarId: string, type: Parameters<typeof buildCalendarEvent>[0]): void {
        if (this.batch.hold()) {
            this.heldCalendars.add(calendarId);
            return;
        }
        this.reachReaders([calendarId], buildCalendarEvent(type, this.home.user.id));
    }

    // The single event a bulk write sends stands for every one it held, so it goes everywhere they would.
    private flushHeldAnnouncements(): void {
        const held = [...this.heldCalendars];
        this.heldCalendars.clear();
        this.reachReaders(held, buildEventsChangedEvent(this.home.user.id));
    }

    // An announcement reaches the owner's own tabs and every Home the calendars are shared with.
    private reachReaders(calendarIds: string[], sseEvent: SSEvent): void {
        this.home.broadcast(sseEvent);
        for (const calendarId of calendarIds) {
            const cal = this.calendarById(calendarId);
            if (cal) notifySharedCalendarUsers(this.home, cal, sseEvent).catch(console.error);
        }
    }

    // A bulk write (a whole-file import) tells the tabs once instead of per resource.
    withBatchedEvents<T>(fn: () => Promise<T>): Promise<T> {
        return this.batch.run(fn);
    }

    // --- Events (writes — implementation in calendar/events.ts) ---

    public async createEvent(calendarId: string, input: CreateEventArgs, user?: User): Promise<CalendarEvent> {
        return events.createEvent(this, calendarId, input, user);
    }

    public async updateEvent(calendarId: string, id: string, input: EventPatch, user?: User): Promise<CalendarEvent> {
        return events.updateEvent(this, calendarId, id, input, user);
    }

    public async deleteEvent(calendarId: string, id: string, user?: User): Promise<void> {
        return events.deleteEvent(this, calendarId, id, user);
    }

    public async moveEvent(calendarId: string, id: string, targetCalendarId: string): Promise<CalendarEvent> {
        return events.moveEvent(this, calendarId, id, targetCalendarId);
    }

    // A whole `.ics` into one calendar of this Home (docs/CALENDAR.md § iCalendar import / export).
    public async importEvents(calendarId: string, bytes: Uint8Array): Promise<ImportCountsResult> {
        return importEvents(this, calendarId, bytes);
    }

    // One calendar, or the series `ids` name, as one `.ics`.
    public async exportEvents(calendarId: string, ids?: string[]): Promise<string> {
        return exportEvents(this, calendarId, ids);
    }

    // --- Shared calendars (implementation in calendar/shares.ts) ---

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

    // --- Invitations (implementation in calendar/invitations.ts) ---

    public async receiveInvitation(payload: ReceiveInvitationPayload): Promise<string | null> {
        return invitations.receiveInvitation(this, payload);
    }

    public async receiveInvitationUpdate(
        orgEventId: string,
        orgUserId: string,
        payload: InvitationUpdatePayload,
    ): Promise<void> {
        return invitations.receiveInvitationUpdate(this, orgEventId, orgUserId, payload);
    }

    public async receiveImipRequest(parsed: ParsedEvent, sender: string): Promise<void> {
        return invitations.receiveImipRequest(this, parsed, sender);
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
