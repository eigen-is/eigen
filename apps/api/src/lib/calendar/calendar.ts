import { randomUUID } from 'node:crypto';
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
import { and, eq, isNull, sql } from 'drizzle-orm';
import type { BunSQLiteDatabase } from 'drizzle-orm/bun-sqlite';
import type ICAL from 'ical.js';
import {
    ApiError,
    BroadcastBatch,
    computeResourceEtag,
    type LocalFilesystem,
    PATHS,
    type PutResourceResult,
    readResourceFile,
    uriKeyOf,
    WriteGate,
} from '../core';
import type { DeleteResourceResult, ManagedDatabase } from '../core/';
import type { Home } from '../home';
import { parseResource } from '../ical';
import type { Revision } from '../ical/ical-component';
import type { ParsedEvent } from '../ical/ical-parse';
import type { User } from '../user';
import type { ResourceCommit, ResourceRow } from './calendar-store';
import * as store from './calendar-store';
import { CALENDAR_DB_CONFIG } from './db-config';
import * as events from './events';
import * as invitations from './invitations';
import { dbCalendarToCalendarItem, toEvent } from './mappers';
import * as occurrences from './occurrences';
import { reconcileIndex, stagedDeletesOf } from './reconcile';
import type { CalendarCollection } from './resource-store';
import {
    calendarDir,
    gateKey,
    parseGateKey,
    resourcePath,
    sanitizeCalendarId,
    statCalendarDir,
} from './resource-store';
import * as schema from './schema';
import { notifySharedCalendarUsers, propagateCalendarShare } from './share-propagation';
import * as shares from './shares';
import { buildCalendarEvent, buildEventsChangedEvent } from './sse-events';
import { importEvents } from './transfer';

import type { CreateEventArgs, InvitationUpdatePayload, ReceiveInvitationPayload, UpdateEventArgs } from './types';

function getCalendarDatabase(home: Home): Promise<ManagedDatabase<typeof schema>> {
    return home.getLocalDatabase(CALENDAR_DB_CONFIG, PATHS.CALENDAR.DB);
}

// The transaction handle drizzle hands a `db.transaction(cb)` callback.
type Tx = Parameters<Parameters<BunSQLiteDatabase<typeof schema>['transaction']>[0]>[0];

export class Calendar {
    private managedDb!: ManagedDatabase<typeof schema>;
    db!: BunSQLiteDatabase<typeof schema>;
    home: Home;
    storage: LocalFilesystem;

    // Process death takes the gate's dirty set with it, which is what `pending_writes` is for.
    gate = new WriteGate((keys, settled) => this.drainDirty(keys, settled));

    // Bytes on disk under `calendars/`, unindexable files included; size() answers from here and never drains.
    eventsBytes = 0;

    // Bulk writes in flight; while any runs, per-resource events are held and the last one out closes them.
    private readonly batch = new BroadcastBatch(() => this.flushHeldAnnouncements());

    // Which calendars the held announcements were for, so the batched event reaches everybody they would.
    private readonly heldCalendars = new Set<string>();

    // Only the reconcile/drain machinery bumps this; the mutation paths parse for their own merges.
    private parses = 0;

    constructor(home: Home, storage: LocalFilesystem) {
        this.home = home;
        this.storage = storage;
    }

    public async init(): Promise<void> {
        this.managedDb = await getCalendarDatabase(this.home);
        this.db = this.managedDb.db;

        await this.storage.mkdir(PATHS.CALENDAR.CALENDARS);

        // The index first: the ctag bumps need its calendar rows. Then finish what a crash left half-applied.
        await reconcileIndex(this);
        await this.gate.recoverPending(
            this.db
                .select()
                .from(schema.pendingWrites)
                .all()
                .map((row) => gateKey(row.calendarId, row.uri)),
        );

        if (this.db.select({ id: schema.calendars.id }).from(schema.calendars).all().length === 0) {
            await this.createCalendar({
                name: this.home.user.name || 'Personal',
                color: EIGEN_ACCENT_COLORS_SHUFFLED[0].value,
                isDefault: true,
            });
        }
    }

    // Never drains and never locks: a quota check reaches it from inside the write gate.
    public async size(): Promise<number> {
        return this.eventsBytes;
    }

    async destruct(): Promise<void> {
        if (this.managedDb) {
            await this.managedDb.close();
        }
    }

    // --- Index seams used by calendar/*.ts ---

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

    // Keyed by uri but carrying the folded uriKey, so a re-created case-variant resource still clears it.
    tombstone(tx: Tx, calendarId: string, uri: string, uriKey: string, ctag: number): void {
        tx.insert(schema.resourceTombstones)
            .values({ calendarId, uri, uriKey, deletedAtCtag: ctag })
            .onConflictDoUpdate({
                target: [schema.resourceTombstones.calendarId, schema.resourceTombstones.uri],
                set: { uriKey, deletedAtCtag: ctag },
            })
            .run();
    }

    // Durable write intent: while the row exists, the index owes that file a commit.
    recordPendingWrite(calendarId: string, uri: string): void {
        this.db.insert(schema.pendingWrites).values({ calendarId, uri }).onConflictDoNothing().run();
    }

    private clearPendingWrite(calendarId: string, uri: string): void {
        this.db
            .delete(schema.pendingWrites)
            .where(and(eq(schema.pendingWrites.calendarId, calendarId), eq(schema.pendingWrites.uri, uri)))
            .run();
    }

    parseResourceFile(bytes: Uint8Array): ICAL.Component {
        this.parses++;
        return parseResource(new TextDecoder().decode(bytes));
    }

    // A clean stat-only reconcile must re-parse nothing, which the restart suite asserts.
    public get resourceParseCount(): number {
        return this.parses;
    }

    // The single index-write seam: the ctag, the resource row, its event rows, the tombstone, all in one transaction.
    commitResource(commit: ResourceCommit): void {
        const uriKey = uriKeyOf(commit.uri);
        this.db.transaction((tx) => {
            const ctag = this.bumpCtag(tx, commit.calendarId);
            const row = {
                uri: commit.uri,
                uriKey,
                uid: commit.uid,
                etag: commit.etag,
                mtime: commit.mtime,
                size: commit.size,
                resourceCtag: ctag,
                hasUnindexedRecurrence: commit.hasUnindexedRecurrence,
            };
            tx.insert(schema.resources)
                .values({ id: commit.id, calendarId: commit.calendarId, ...row })
                .onConflictDoUpdate({ target: schema.resources.id, set: row })
                .run();
            tx.delete(schema.events).where(eq(schema.events.resourceId, commit.id)).run();
            for (const event of commit.rows) tx.insert(schema.events).values(event).run();
            // So no href is ever both a 200 and a 404 in one sync response.
            tx.delete(schema.resourceTombstones)
                .where(
                    and(
                        eq(schema.resourceTombstones.calendarId, commit.calendarId),
                        eq(schema.resourceTombstones.uriKey, uriKey),
                    ),
                )
                .run();
            // The write intent settles in the very transaction that settles the pair; a crash earlier leaves it for init.
            tx.delete(schema.pendingWrites)
                .where(
                    and(
                        eq(schema.pendingWrites.calendarId, commit.calendarId),
                        eq(schema.pendingWrites.uri, commit.uri),
                    ),
                )
                .run();
        });
    }

    // Caller holds the gate. No pending row: a delete makes the name vanish, which the stat diff always sees.
    async purgeResource(row: typeof schema.resources.$inferSelect): Promise<void> {
        await this.storage.unlinkDurable(resourcePath(row.calendarId, row.uri));
        try {
            this.db.transaction((tx) => {
                const ctag = this.bumpCtag(tx, row.calendarId);
                tx.delete(schema.resources).where(eq(schema.resources.id, row.id)).run();
                this.tombstone(tx, row.calendarId, row.uri, row.uriKey, ctag);
            });
        } catch (e) {
            this.gate.markDirty(gateKey(row.calendarId, row.uri));
            throw e;
        }
        this.eventsBytes -= row.size;
    }

    // The gate's re-index, caller holding the lock: the file is persisted, the index is behind it.
    private async drainDirty(keys: string[], settled: (key: string) => void): Promise<void> {
        for (const key of keys) {
            const { calendarId, uri } = parseGateKey(key);
            const existing = this.db
                .select()
                .from(schema.resources)
                .where(and(eq(schema.resources.calendarId, calendarId), eq(schema.resources.uriKey, uriKeyOf(uri))))
                .get();
            const bytes = this.calendarRow(calendarId)
                ? await readResourceFile(this.storage, resourcePath(calendarId, existing?.uri ?? uri))
                : null;
            // A file the row already describes settles without a commit: a lock-free read that raced a write
            // marks a pair that is whole, and a commit would bump a ctag for nothing.
            if (bytes) {
                await this.indexIfChanged(calendarId, existing?.uri ?? uri, bytes, existing);
            } else if (existing) {
                this.db.transaction((tx) => {
                    const ctag = this.bumpCtag(tx, calendarId);
                    tx.delete(schema.resources).where(eq(schema.resources.id, existing.id)).run();
                    this.tombstone(tx, calendarId, existing.uri, existing.uriKey, ctag);
                });
                this.eventsBytes -= existing.size;
            }
            this.clearPendingWrite(calendarId, uri);
            settled(key);
        }
    }

    private async indexIfChanged(
        calendarId: string,
        uri: string,
        bytes: Uint8Array,
        existing: typeof schema.resources.$inferSelect | undefined,
    ): Promise<boolean> {
        const etag = computeResourceEtag(bytes);
        if (etag === existing?.etag) return false;
        const resource = this.parseResourceFile(bytes);
        const id = existing?.id ?? randomUUID();
        const projection = store.projectRows(calendarId, id, resource);
        const uid = projection.rows[0]?.uid;
        if (!uid) return false;
        const stat = await this.storage.stat(resourcePath(calendarId, uri));
        this.commitResource({
            id,
            calendarId,
            uri,
            uid,
            etag,
            mtime: Math.round(stat.mtimeMs),
            size: stat.size,
            rows: projection.rows,
            hasUnindexedRecurrence: projection.hasUnindexedRecurrence,
        });
        this.eventsBytes += stat.size - (existing?.size ?? 0);
        return true;
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

    // The ctag and the generation a rebuild rotates make the sync token; a torn pair would name one no file carries.
    public async getCollections(): Promise<CalendarCollection[]> {
        await this.gate.ensureDrained();
        return this.db
            .select()
            .from(schema.calendars)
            .all()
            .map((row) => ({ ...dbCalendarToCalendarItem(row), syncGen: row.syncGen }));
    }

    public async getCollection(id: string): Promise<CalendarCollection | null> {
        await this.gate.ensureDrained();
        const row = this.calendarRow(id);
        return row ? { ...dbCalendarToCalendarItem(row), syncGen: row.syncGen } : null;
    }

    // A calendar id is a directory name, so it is unique case-insensitively: two rows would reconcile one directory.
    public async createCalendar(input: {
        name: string;
        color: string;
        id?: string;
        isDefault?: boolean;
    }): Promise<CalendarItem> {
        const id = input.id ?? randomUUID();
        if (sanitizeCalendarId(id) !== id) throw new ApiError(400, 'Invalid calendar name');

        // Inside the gate, so a create and a delete of the same id serialize over its staging directory.
        const created = await this.gate.run(async () => {
            if (this.calendarIdTaken(id)) throw new ApiError(409, 'Calendar already exists');

            // A free id means the delete that held it committed, so its leftover staging is deleted data.
            for (const staged of await stagedDeletesOf(this, id)) await this.storage.removeDir(staged);

            // The directory first: an empty calendar survives a lost database only if it is on disk.
            await this.storage.mkdir(calendarDir(id));
            this.db
                .insert(schema.calendars)
                .values({
                    id,
                    name: input.name.trim(),
                    color: input.color,
                    isDefault: input.isDefault ?? false,
                    ctag: 0,
                    shares: null,
                })
                .run();
            return this.calendarById(id)!;
        });

        this.home.broadcast(buildCalendarEvent(SSEventType.CALENDAR_CREATED, this.home.user.id));
        return created;
    }

    calendarIdTaken(id: string): boolean {
        const folded = id.toLowerCase();
        return this.db
            .select({ id: schema.calendars.id })
            .from(schema.calendars)
            .all()
            .some((row) => row.id.toLowerCase() === folded);
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

        // Outside the gate: two Homes each deleting a calendar shared with the other would be a two-lock cycle.
        if (existing.shares?.length) {
            await propagateCalendarShare(this.home, { ...existing, shares: [] }, existing.shares);
        }

        await this.gate.run(async () => {
            const staged = `${PATHS.CALENDAR.CALENDARS}/.${id}.deleting-${randomUUID()}`;
            // What the directory holds, not what the index indexed: the counter carries every file on disk.
            const scan = await statCalendarDir(this.storage, id);
            const bytes = [...scan.files.values()].reduce((sum, file) => sum + file.size, 0);
            // Staged first, committed second: the init sweep decides by the row, so a crash in between rolls back.
            await this.storage.moveDurable(calendarDir(id), staged);
            try {
                this.db.delete(schema.calendars).where(eq(schema.calendars.id, id)).run();
            } catch (e) {
                // A live process rolls its own rename back, or a write in between would recreate the directory.
                await this.storage.moveDurable(staged, calendarDir(id));
                throw e;
            }
            await this.storage.removeDir(staged);
            this.eventsBytes -= bytes;
        });

        this.home.broadcast(buildCalendarEvent(SSEventType.CALENDAR_DELETED, this.home.user.id));
    }

    // --- Resources (the DAV store facade — implementation in calendar/calendar-store.ts) ---

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
        pre: { ifMatch: string | null; ifNoneMatch: string | null; actor?: string | null },
    ): Promise<PutResourceResult> {
        const ctagBefore = this.calendarRow(calendarId)?.ctag;
        const result = await store.putResource(this, calendarId, uri, body, pre);
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
        const rows = await this.getRawEventsInRange(calendarId, from, to);
        await this.gate.ensureDrained();
        const matched = new Set(rows.map((row) => row.uri));
        return (await this.listResources(calendarId)).filter(
            (resource) => matched.has(resource.uri) || resource.hasUnindexedRecurrence,
        );
    }

    // --- Events (reads) ---

    joinedEvents() {
        return this.db
            .select()
            .from(schema.events)
            .innerJoin(schema.resources, eq(schema.events.resourceId, schema.resources.id));
    }

    public async getEventsByUid(uid: string): Promise<CalendarEvent[]> {
        await this.gate.ensureDrained();
        return this.joinedEvents().where(eq(schema.events.uid, uid)).all().map(toEvent);
    }

    public async getEventByUri(calendarId: string, uri: string): Promise<CalendarEvent | null> {
        await this.gate.ensureDrained();
        const row = this.joinedEvents()
            .where(and(eq(schema.resources.calendarId, calendarId), eq(schema.resources.uriKey, uriKeyOf(uri))))
            .all()
            .find((joined) => joined.events.parentEventId === null);
        return row ? toEvent(row) : null;
    }

    public async getRawEvents(calendarId: string): Promise<CalendarEvent[]> {
        await this.gate.ensureDrained();
        return this.joinedEvents().where(eq(schema.events.calendarId, calendarId)).all().map(toEvent);
    }

    public async getRawEventsInRange(calendarId: string, from: Date, to: Date): Promise<CalendarEvent[]> {
        return occurrences.getRawEventsInRange(this, calendarId, from, to);
    }

    public async getEventsInRange(from: Date, to: Date, calendarId?: string): Promise<CalendarEventOccurrence[]> {
        return occurrences.getEventsInRange(this, from, to, calendarId);
    }

    public async getEventsWithAttendee(email: string): Promise<CalendarEvent[]> {
        await this.gate.ensureDrained();
        return this.joinedEvents()
            .where(isNull(schema.events.organizerEventId))
            .all()
            .map(toEvent)
            .filter((e) => e.data?.attendees?.some((a) => a.email.toLowerCase() === email.toLowerCase()));
    }

    // --- Events (writes — implementation in calendar/events.ts) ---

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

    public async createEvent(calendarId: string, input: CreateEventArgs, user?: User): Promise<CalendarEvent> {
        return events.createEvent(this, calendarId, input, user);
    }

    public async updateEvent(
        calendarId: string,
        id: string,
        input: UpdateEventArgs,
        user?: User,
    ): Promise<CalendarEvent> {
        return events.updateEvent(this, calendarId, id, input, user);
    }

    public async deleteEvent(calendarId: string, id: string, user?: User): Promise<void> {
        return events.deleteEvent(this, calendarId, id, user);
    }

    public async moveEvent(calendarId: string, id: string, targetCalendarId: string): Promise<CalendarEvent> {
        return events.moveEvent(this, calendarId, id, targetCalendarId);
    }

    // A whole `.ics` into one calendar of this Home (docs/CALENDAR.md § Importing an .ics).
    public async importEvents(calendarId: string, bytes: Uint8Array): Promise<ImportCountsResult> {
        return importEvents(this, calendarId, bytes);
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

    public async updateAttendeeStatus(eventId: string, email: string, status: Attendee['status']): Promise<void> {
        return invitations.updateAttendeeStatus(this, eventId, email, status);
    }

    public async rsvpForOccurrence(
        eventId: string,
        email: string,
        status: Attendee['status'],
        recurrenceDate: string,
        recurrenceInstant?: Date | null,
        restoreCancelled = true,
    ): Promise<void> {
        return invitations.rsvpForOccurrence(
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
