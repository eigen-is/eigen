// Import from the calendar-utils module directly (NOT the @workspace/lib/calendar barrel,
// which re-exports React-query hooks) so the API stays free of React in its module graph.

import { randomUUID } from 'node:crypto';
import { isInvitationFromOthers, occurrenceDateToString, truncateRRule } from '@workspace/lib/calendar/calendar-utils';
import { EIGEN_ACCENT_COLORS_SHUFFLED } from '@workspace/lib/constants/colors';
import type {
    Attendee,
    CalendarEvent,
    CalendarEventOccurrence,
    CalendarItem,
    CalendarShare,
    EventData,
    SharedCalendar,
} from '@workspace/lib/types/calendar';
import { externalOwnerId, isExternalOwnerId } from '@workspace/lib/types/owner';
import { SSEventType } from '@workspace/lib/types/sse';
import type { ImportCountsResult } from '@workspace/lib/types/transfer';
import { and, eq, gte, isNull, lte, sql } from 'drizzle-orm';
import type { BunSQLiteDatabase } from 'drizzle-orm/bun-sqlite';
import type ICAL from 'ical.js';
import { RRule } from 'rrule';
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
import { sendMail } from '../core/mailer';
import type { Home } from '../home';
import {
    addExclusion,
    buildResource,
    isNewerRevision,
    parseResource,
    patchEvent,
    putOverride,
    removeExclusion,
    stampInvitationLink,
    storedOrganizerAddress,
    storedRevision,
} from '../ical';
import type { EventPatch, Revision, WriteContext } from '../ical/ical-component';
import type { ParsedEvent } from '../ical/ical-parse';
import { clampRangeEnd, isOutOfRangeRecurrenceStart, isSubDailyRrule } from '../ical/recurrence-limits';
import { computeOccurrenceTimes, storedRecurrenceKey, utcToLocal } from '../ical/wall-clock';
import { actorDisplayName, type User } from '../user';
import type { ResourceCommit, ResourceRow } from './calendar-store';
import * as store from './calendar-store';
import { CALENDAR_DB_CONFIG } from './db-config';
import { eventForFile, validateEventInput } from './event-input';
import { composeRsvpReply } from './imip';
import { propagateCancellation, propagateDecline, propagateInvitation, propagateRsvp } from './invite-propagation';
import { dbCalendarToCalendarItem, dbEventToCalendarEvent } from './mappers';
import { reconcileIndex, stagedDeletesOf } from './reconcile';
import { constrainRRule, expandRecurrence } from './recurrence';
import type { CalendarCollection } from './resource-store';
import {
    calendarDir,
    gateKey,
    parseGateKey,
    resourcePath,
    sanitizeCalendarId,
    sanitizeEventUri,
    statCalendarDir,
} from './resource-store';
import * as schema from './schema';
import { notifySharedCalendarUsers, propagateCalendarShare } from './share-propagation';
import * as shares from './shares';
import { buildCalendarEvent, buildEventsChangedEvent } from './sse-events';
import { importEvents } from './transfer';

import type {
    CreateEventArgs,
    InvitationExceptionPayload,
    InvitationUpdatePayload,
    ReceiveInvitationPayload,
    UpdateEventArgs,
} from './types';

function getCalendarDatabase(home: Home): Promise<ManagedDatabase<typeof schema>> {
    return home.getLocalDatabase(CALENDAR_DB_CONFIG, PATHS.CALENDAR.DB);
}

// The transaction handle drizzle hands a `db.transaction(cb)` callback.
type Tx = Parameters<Parameters<BunSQLiteDatabase<typeof schema>['transaction']>[0]>[0];

// An event row and the file it was projected from — what every read of a stored event answers with.
type JoinedEvent = { events: typeof schema.events.$inferSelect; resources: typeof schema.resources.$inferSelect };

// What the inbound-REQUEST decision did, so the broadcast and the notification can run after release.
type InboundRequestOutcome =
    | { kind: 'dropped'; reason: string }
    | { kind: 'updated'; linked: CalendarEvent }
    | { kind: 'created'; calendarId: string; payload: ReceiveInvitationPayload };

function inboundUpdatePayload(parsed: ParsedEvent): InvitationUpdatePayload {
    return {
        title: parsed.title,
        description: parsed.description,
        location: parsed.location,
        startTime: parsed.startTime,
        endTime: parsed.endTime,
        allDay: parsed.allDay,
        rrule: parsed.rrule,
        timezone: parsed.timezone,
        status: parsed.status,
        sequence: parsed.sequence,
        dtstamp: parsed.dtstamp,
        attendees: parsed.data?.attendees,
    };
}

function inboundExceptionPayload(parsed: ParsedEvent): InvitationExceptionPayload {
    return {
        recurrenceDate: parsed.recurrenceDate!,
        recurrenceInstant: parsed.recurrenceInstant,
        title: parsed.title,
        description: parsed.description,
        location: parsed.location,
        startTime: parsed.startTime,
        endTime: parsed.endTime,
        allDay: parsed.allDay,
        timezone: parsed.timezone,
        status: parsed.status,
        sequence: parsed.sequence,
        dtstamp: parsed.dtstamp,
        attendees: parsed.data?.attendees,
    };
}

// An external organizer is known by address only, so the link is `external_<address>` on both stamps.
function inboundInvitationPayload(parsed: ParsedEvent, sender: string): ReceiveInvitationPayload {
    const organizerUserId = externalOwnerId(sender);
    return {
        uid: parsed.uid,
        title: parsed.title,
        description: parsed.description,
        location: parsed.location,
        startTime: parsed.startTime,
        endTime: parsed.endTime,
        allDay: parsed.allDay,
        rrule: parsed.rrule,
        timezone: parsed.timezone,
        status: parsed.status,
        sequence: parsed.sequence,
        dtstamp: parsed.dtstamp,
        data: {
            ...parsed.data,
            organizer: parsed.data?.organizer ? { ...parsed.data.organizer, userId: organizerUserId } : undefined,
            organizerEventId: parsed.uid,
        },
        createByUserId: organizerUserId,
        organizerEventId: parsed.uid,
        organizerUserId,
    };
}

export class Calendar {
    private managedDb!: ManagedDatabase<typeof schema>;
    db!: BunSQLiteDatabase<typeof schema>; // internal — used by calendar/*.ts
    home: Home; // internal — used by calendar/*.ts
    storage: LocalFilesystem; // internal — used by calendar/*.ts

    // Process death takes the gate's dirty set with it, which is what `pending_writes` is for.
    gate = new WriteGate((keys, settled) => this.drainDirty(keys, settled)); // internal — used by calendar/*.ts

    // Bytes on disk under `calendars/`, unindexable files included; size() answers from here and never drains.
    eventsBytes = 0; // internal — used by calendar/*.ts

    // Bulk writes in flight; while any runs, per-resource events are held and the last one out closes them.
    private readonly batch = new BroadcastBatch(() => this.home.broadcast(buildEventsChangedEvent(this.home.user.id)));

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

        // Bring the index in line with the files first — it guarantees the calendar rows the ctag bumps
        // need — then finish what a crash left half-applied, and only then seed.
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

    // Answered purely from the in-memory counter, and it must NEVER drain or lock: a quota check reaches
    // it from inside the write gate, where a drain is a no-op anyway.
    public async size(): Promise<number> {
        return this.eventsBytes;
    }

    async destruct(): Promise<void> {
        if (this.managedDb) {
            await this.managedDb.close();
        }
    }

    // --- Index seams used by calendar/*.ts ---

    // internal — used by calendar/*.ts
    calendarRow(id: string): typeof schema.calendars.$inferSelect | null {
        return this.db.select().from(schema.calendars).where(eq(schema.calendars.id, id)).get() ?? null;
    }

    // internal — used by calendar/*.ts
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
    // internal — used by calendar/*.ts
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
    // internal — used by calendar/*.ts
    recordPendingWrite(calendarId: string, uri: string): void {
        this.db.insert(schema.pendingWrites).values({ calendarId, uri }).onConflictDoNothing().run();
    }

    private clearPendingWrite(calendarId: string, uri: string): void {
        this.db
            .delete(schema.pendingWrites)
            .where(and(eq(schema.pendingWrites.calendarId, calendarId), eq(schema.pendingWrites.uri, uri)))
            .run();
    }

    // internal — used by calendar/*.ts
    parseResourceFile(bytes: Uint8Array): ICAL.Component {
        this.parses++;
        return parseResource(new TextDecoder().decode(bytes));
    }

    // A clean stat-only reconcile must re-parse nothing: the tests assert this stays flat across a second
    // init over unchanged files.
    public get resourceParseCount(): number {
        return this.parses;
    }

    // The single index-write seam: ctag bump, resource upsert, every event row of the file replaced,
    // tombstone clear and pending-write clear, all in one transaction.
    // internal — used by calendar/*.ts
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
            // The write intent recorded before the file rename is settled in the very transaction that
            // settles the pair — a crash anywhere earlier leaves the row for init to drain.
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

    // Callers hold the gate and have already run their own guards. No pending row: a delete makes the
    // name vanish, which the stat diff always sees.
    // internal — used by calendar/*.ts
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
            // A file the row already describes settles without a commit: a lock-free read that raced a
            // write marks a pair that is whole, and a commit would bump a ctag for nothing.
            if (bytes && (await this.indexIfChanged(calendarId, existing?.uri ?? uri, bytes, existing))) {
                // committed
            } else if (!bytes && existing) {
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

    // The sync row read behind getCalendarById, for the paths that may not await: the private sync
    // helpers and the bodies of `db.transaction()` callbacks, which commit at the first await.
    private calendarById(id: string): CalendarItem | null {
        const row = this.calendarRow(id);
        return row ? dbCalendarToCalendarItem(row) : null;
    }

    // The DAV view of a collection: its ctag plus the generation a rebuild rotates, which together make
    // the sync token. Drained, because a torn pair would answer with a ctag its files do not carry.
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

    // A calendar id is a directory name, so it is unique case-insensitively: two rows over one directory
    // would both reconcile the same files and the second pass would rewrite every one of them.
    public async createCalendar(input: {
        name: string;
        color: string;
        id?: string;
        isDefault?: boolean;
    }): Promise<CalendarItem> {
        const id = input.id ?? randomUUID();
        if (sanitizeCalendarId(id) !== id) throw new ApiError(400, 'Invalid calendar name');
        if (this.calendarIdTaken(id)) throw new ApiError(409, 'Calendar already exists');

        // An id is free only because the delete that held it committed, so its leftover staging is deleted
        // data: dropping it here is what stops a later sweep rolling it into this calendar.
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

        this.home.broadcast(buildCalendarEvent(SSEventType.CALENDAR_CREATED, this.home.user.id));
        return this.calendarById(id)!;
    }

    // internal — used by calendar/*.ts
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

        // Outside the gate: propagateCalendarShare relays into other Homes, and two Homes each deleting a
        // calendar shared with the other would be a two-lock cycle.
        if (existing.shares?.length) {
            await propagateCalendarShare(this.home, { ...existing, shares: [] }, existing.shares);
        }

        await this.gate.run(async () => {
            const staged = `${PATHS.CALENDAR.CALENDARS}/.${id}.deleting-${randomUUID()}`;
            // What the directory holds, not what the index indexed: the counter carries every file on disk.
            const scan = await statCalendarDir(this.storage, id);
            const bytes = [...scan.files.values()].reduce((sum, file) => sum + file.size, 0);
            // Staged first, committed second: the init sweep decides by the row, so a crash in between
            // rolls the directory back rather than losing every event of a delete nobody acknowledged.
            await this.storage.moveDurable(calendarDir(id), staged);
            try {
                this.db.delete(schema.calendars).where(eq(schema.calendars.id, id)).run();
            } catch (e) {
                // A live process rolls its own rename back: leaving it for the sweep would let any write in
                // between recreate the directory, and the delete would then read as one that committed.
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

    // The collection's resources whose series touches the window, plus every resource the index cannot
    // expand: a stripped sub-daily rule or an RDATE still has occurrences a client must be told about.
    public async getResourcesInRange(calendarId: string, from: Date, to: Date): Promise<ResourceRow[]> {
        const rows = await this.getRawEventsInRange(calendarId, from, to);
        await this.gate.ensureDrained();
        const matched = new Set(rows.map((row) => row.uri));
        return (await this.listResources(calendarId)).filter(
            (resource) => matched.has(resource.uri) || resource.hasUnindexedRecurrence,
        );
    }

    // --- Events (reads) ---

    private joinedEvents() {
        return this.db
            .select()
            .from(schema.events)
            .innerJoin(schema.resources, eq(schema.events.resourceId, schema.resources.id));
    }

    private static toEvent(row: JoinedEvent): CalendarEvent {
        return dbEventToCalendarEvent(row.events, row.resources);
    }

    private eventById(id: string): CalendarEvent | null {
        const row = this.joinedEvents().where(eq(schema.events.id, id)).get();
        return row ? Calendar.toEvent(row) : null;
    }

    public async getEventsByUid(uid: string): Promise<CalendarEvent[]> {
        await this.gate.ensureDrained();
        return this.joinedEvents().where(eq(schema.events.uid, uid)).all().map(Calendar.toEvent);
    }

    public async getEventByUri(calendarId: string, uri: string): Promise<CalendarEvent | null> {
        await this.gate.ensureDrained();
        const row = this.joinedEvents()
            .where(and(eq(schema.resources.calendarId, calendarId), eq(schema.resources.uriKey, uriKeyOf(uri))))
            .all()
            .find((joined) => joined.events.parentEventId === null);
        return row ? Calendar.toEvent(row) : null;
    }

    public async getRawEvents(calendarId: string): Promise<CalendarEvent[]> {
        await this.gate.ensureDrained();
        return this.joinedEvents().where(eq(schema.events.calendarId, calendarId)).all().map(Calendar.toEvent);
    }

    // A recurring master's exception rows. Uses idx_events_parent.
    public async getExceptionsForParent(parentEventId: string): Promise<CalendarEvent[]> {
        await this.gate.ensureDrained();
        return this.joinedEvents().where(eq(schema.events.parentEventId, parentEventId)).all().map(Calendar.toEvent);
    }

    public async getRawEventsInRange(calendarId: string, from: Date, to: Date): Promise<CalendarEvent[]> {
        // Clamp the window span (see recurrence-limits) so an over-wide CalDAV time-range can't make
        // rrule materialise a giant occurrence set and block the event loop.
        const clampedTo = clampRangeEnd(from, to);
        await this.gate.ensureDrained();

        const nonRecurring = this.joinedEvents()
            .where(
                and(
                    eq(schema.events.calendarId, calendarId),
                    isNull(schema.events.rrule),
                    isNull(schema.events.parentEventId),
                    lte(schema.events.startTime, clampedTo),
                    gte(schema.events.endTime, from),
                ),
            )
            .all()
            .map(Calendar.toEvent);

        const matching: CalendarEvent[] = [];
        const matchingIds = new Set<string>();
        for (const row of this.joinedEvents()
            .where(
                and(
                    eq(schema.events.calendarId, calendarId),
                    sql`${schema.events.rrule} IS NOT NULL`,
                    isNull(schema.events.parentEventId),
                ),
            )
            .all()) {
            const event = Calendar.toEvent(row);
            if (expandRecurrence(event, from, clampedTo).length > 0) {
                matching.push(event);
                matchingIds.add(event.id);
            }
        }

        const exceptions: CalendarEvent[] = [];
        if (matchingIds.size > 0) {
            for (const row of this.joinedEvents()
                .where(and(eq(schema.events.calendarId, calendarId), sql`${schema.events.parentEventId} IS NOT NULL`))
                .all()) {
                const event = Calendar.toEvent(row);
                if (event.parentEventId && matchingIds.has(event.parentEventId)) exceptions.push(event);
            }
        }

        return [...nonRecurring, ...matching, ...exceptions];
    }

    public async getEventsInRange(from: Date, to: Date, calendarId?: string): Promise<CalendarEventOccurrence[]> {
        // Clamp the window span (see recurrence-limits) so an over-wide range like
        // event-range/0/253402300799 can't make rrule materialise a giant occurrence set.
        const clampedTo = clampRangeEnd(from, to);
        await this.gate.ensureDrained();

        const scoped = calendarId ? [eq(schema.events.calendarId, calendarId)] : [];

        const nonRecurring = this.joinedEvents()
            .where(
                and(
                    ...scoped,
                    isNull(schema.events.rrule),
                    isNull(schema.events.parentEventId),
                    lte(schema.events.startTime, clampedTo),
                    gte(schema.events.endTime, from),
                ),
            )
            .all()
            .map(Calendar.toEvent);

        const recurring = this.joinedEvents()
            .where(and(...scoped, sql`${schema.events.rrule} IS NOT NULL`, isNull(schema.events.parentEventId)))
            .all()
            .map(Calendar.toEvent);

        const exceptionsByParent = new Map<string, CalendarEvent[]>();
        for (const row of this.joinedEvents()
            .where(and(...scoped, sql`${schema.events.parentEventId} IS NOT NULL`))
            .all()) {
            const event = Calendar.toEvent(row);
            const group = exceptionsByParent.get(event.parentEventId!) ?? [];
            exceptionsByParent.set(event.parentEventId!, group);
            group.push(event);
        }

        const results: CalendarEventOccurrence[] = [];
        for (const event of nonRecurring) {
            results.push({ ...event, occurrenceDate: occurrenceDateToString(event.startTime) });
        }

        for (const event of recurring) {
            const cancelledDates = new Set<string>();
            const modifiedDates = new Map<string, CalendarEvent>();
            for (const exception of exceptionsByParent.get(event.id) ?? []) {
                const dateKey = exception.recurrenceDate ? storedRecurrenceKey(exception.recurrenceDate) : null;
                if (!dateKey) continue;
                if (exception.status === 'cancelled') cancelledDates.add(dateKey);
                else modifiedDates.set(dateKey, exception);
            }

            for (const occurrence of expandRecurrence(event, from, clampedTo)) {
                if (cancelledDates.has(occurrence.occurrenceDate)) continue;
                const modified = modifiedDates.get(occurrence.occurrenceDate);
                // Keep the stored exception key, not the UTC date of the (possibly moved) startTime —
                // the FE round-trips occurrenceDate into scope='this' RSVPs, and a drifted key would
                // miss getException and duplicate the exception row.
                results.push(modified ? { ...modified, occurrenceDate: occurrence.occurrenceDate } : occurrence);
            }
        }

        results.sort((a, b) => a.startTime.getTime() - b.startTime.getTime());
        return results;
    }

    public async getEventsWithAttendee(email: string): Promise<CalendarEvent[]> {
        await this.gate.ensureDrained();
        return this.joinedEvents()
            .where(isNull(schema.events.organizerEventId))
            .all()
            .map(Calendar.toEvent)
            .filter((e) => e.data?.attendees?.some((a) => a.email.toLowerCase() === email.toLowerCase()));
    }

    // --- Events (writes) ---

    private announce(calendarId: string, type: Parameters<typeof buildCalendarEvent>[0]): void {
        if (this.batch.hold()) return;
        const sseEvent = buildCalendarEvent(type, this.home.user.id);
        this.home.broadcast(sseEvent);
        const cal = this.calendarById(calendarId);
        if (cal) notifySharedCalendarUsers(this.home, cal, sseEvent).catch(() => {});
    }

    // A bulk write (a whole-file import) tells the tabs once instead of per resource.
    // internal — used by calendar/*.ts
    withBatchedEvents<T>(fn: () => Promise<T>): Promise<T> {
        return this.batch.run(fn);
    }

    // The UID rule is Home-wide here, where the index only keeps it unique per calendar: a re-import of a
    // series already filed under another calendar is a re-import, not a second copy.
    // internal — used by calendar/*.ts
    async holdsUid(uid: string): Promise<boolean> {
        await this.gate.ensureDrained();
        return !!this.db
            .select({ uid: schema.resources.uid })
            .from(schema.resources)
            .where(eq(schema.resources.uid, uid))
            .get();
    }

    // The stored component of a resource, or null when the file is gone under a row that still names it.
    private async loadResource(calendarId: string, uri: string): Promise<ICAL.Component | null> {
        const bytes = await readResourceFile(this.storage, resourcePath(calendarId, uri));
        if (!bytes) {
            this.gate.markDirty(gateKey(calendarId, uri));
            return null;
        }
        return this.parseResourceFile(bytes);
    }

    private resourceOf(eventId: string): typeof schema.resources.$inferSelect | null {
        const row = this.db
            .select()
            .from(schema.resources)
            .innerJoin(schema.events, eq(schema.events.resourceId, schema.resources.id))
            .where(eq(schema.events.id, eventId))
            .get();
        return row ? row.resources : null;
    }

    // Load a stored resource, hand its component to `mutate`, and write the pair back. The caller holds
    // the gate; a throw after the rename leaves the key dirty for the next drain.
    private async editResource(
        resource: typeof schema.resources.$inferSelect,
        mutate: (component: ICAL.Component) => void,
    ): Promise<void> {
        const component = await this.loadResource(resource.calendarId, resource.uri);
        if (!component) throw new ApiError(404, 'Event not found');
        mutate(component);
        await store.writeResource(this, resource.calendarId, resource.uri, component, resource);
    }

    private writeContext(actorIsOrganizer: boolean, dtstamp?: Date | null): WriteContext {
        return { now: new Date(), actorIsOrganizer, dtstamp };
    }

    public async createEvent(calendarId: string, input: CreateEventArgs, user?: User): Promise<CalendarEvent> {
        const cal = this.calendarById(calendarId);
        if (!cal) throw new ApiError(404, 'Calendar not found');

        const created = await this.gate.run(() => this.writeEvent(calendarId, input));

        this.announce(calendarId, SSEventType.CALENDAR_EVENT_CREATED);
        if (user && created.data?.attendees?.length) {
            propagateInvitation(this.home, created, user, [], created.data.attendees).catch(console.error);
        }
        return created;
    }

    // The locked core every writer of a NEW event shares: the caller holds the gate, and the checks that
    // decide WHICH file is written — the name, the UID, and an override's parent — run inside it.
    // internal — used by calendar/*.ts
    async writeEvent(calendarId: string, input: CreateEventArgs): Promise<CalendarEvent> {
        validateEventInput(input);
        if (input.parentEventId) return this.writeOverride(calendarId, input);

        const uri = input.uri ?? `${randomUUID()}.ics`;
        if (sanitizeEventUri(uri) !== uri) throw new ApiError(400, 'Invalid event name');
        const uid = input.uid || randomUUID();
        if (this.uidHolder(calendarId, uid)) throw new ApiError(409, 'An event with this UID already exists');
        const event = eventForFile({ id: randomUUID(), calendarId, uid, input, now: new Date() });
        await store.writeResource(this, calendarId, uri, buildResource([event]), null);
        return this.eventById(event.id)!;
    }

    // An exception is one VEVENT inside its master's file: an override replaces the occurrence, a
    // cancellation rides as an EXDATE plus the stamp carrying its row id.
    private async writeOverride(calendarId: string, input: CreateEventArgs): Promise<CalendarEvent> {
        const parent = this.eventById(input.parentEventId!);
        if (!parent || parent.calendarId !== calendarId || parent.parentEventId) {
            throw new ApiError(404, 'Event not found');
        }
        const resource = this.resourceOf(parent.id);
        if (!resource) throw new ApiError(404, 'Event not found');
        // An occurrence the file cannot name is an occurrence the series cannot hold: a RECURRENCE-ID
        // and an EXDATE are both written from this key.
        if (!input.recurrenceDate || !storedRecurrenceKey(input.recurrenceDate)) {
            throw new ApiError(400, 'Invalid occurrence date');
        }

        const override = eventForFile({
            id: randomUUID(),
            calendarId,
            uid: parent.uid,
            input: { ...input, rrule: null },
            now: new Date(),
        });
        await this.editResource(resource, (component) => {
            if (override.status === 'cancelled') {
                addExclusion(component, parent, override, this.writeContext(true, input.dtstamp));
            } else {
                putOverride(component, parent, override);
            }
        });
        const stored = this.exceptionOf(parent.id, override.recurrenceDate);
        return stored ?? this.eventById(parent.id)!;
    }

    private exceptionOf(parentEventId: string, recurrenceDate: string | null): CalendarEvent | null {
        if (!recurrenceDate) return null;
        const key = storedRecurrenceKey(recurrenceDate);
        if (!key) return null;
        const row = this.joinedEvents()
            .where(and(eq(schema.events.parentEventId, parentEventId), eq(schema.events.recurrenceDate, key)))
            .get();
        return row ? Calendar.toEvent(row) : null;
    }

    private uidHolder(calendarId: string, uid: string): { uri: string } | undefined {
        return this.db
            .select({ uri: schema.resources.uri })
            .from(schema.resources)
            .where(and(eq(schema.resources.calendarId, calendarId), eq(schema.resources.uid, uid)))
            .get();
    }

    public async updateEvent(
        calendarId: string,
        id: string,
        input: UpdateEventArgs,
        user?: User,
    ): Promise<CalendarEvent> {
        const existing = this.eventById(id);
        // 404 (not 403) on calendar mismatch so a share on one calendar can't oracle event ids in another.
        if (!existing || existing.calendarId !== calendarId) throw new ApiError(404, 'Event not found');

        // Linked event guard: attendees can only change local fields (reminders, color).
        const linked = isInvitationFromOthers(existing, this.home.user.email);
        if (linked) {
            const localData: EventData = { ...existing.data };
            if (input.data) {
                localData.reminders = input.data.reminders ?? localData.reminders;
                localData.color = input.data.color ?? localData.color;
            }
            input = { data: localData };
        }

        const oldAttendees = existing.data?.attendees ?? [];
        const startTime = input.startTime ?? existing.startTime;
        const endTime = input.endTime ?? existing.endTime;
        // Same interval invariant as createEvent, on the resolved (possibly dragged) times.
        if (endTime < startTime) throw new ApiError(400, 'Event end time cannot be before start time');

        const rruleStr = input.rrule !== undefined ? (input.rrule ?? null) : (existing.rrule ?? null);
        if (rruleStr && input.rrule !== undefined) {
            try {
                RRule.parseString(rruleStr);
            } catch {
                throw new ApiError(400, 'Invalid RRULE');
            }
            if (isSubDailyRrule(rruleStr)) throw new ApiError(400, 'Sub-daily recurrence is not supported');
        }
        // Both directions poison a stored row: adding an rrule to a far-out-of-range event and moving
        // a recurring event's start out of range (see recurrence-limits).
        if (
            rruleStr &&
            (input.rrule !== undefined || input.startTime !== undefined) &&
            isOutOfRangeRecurrenceStart(startTime)
        ) {
            throw new ApiError(400, 'Recurring event start time is out of range');
        }

        const resource = this.resourceOf(id);
        if (!resource) throw new ApiError(404, 'Event not found');

        await this.gate.run(async () => {
            const key = existing.recurrenceDate ? storedRecurrenceKey(existing.recurrenceDate) : null;
            await this.editResource(resource, (component) => {
                patchEvent(
                    component,
                    key,
                    {
                        title: input.title?.trim(),
                        description: input.description,
                        location: input.location,
                        startTime: input.startTime,
                        endTime: input.endTime,
                        allDay: input.allDay,
                        rrule: input.rrule ?? undefined,
                        timezone: input.timezone,
                        status: input.status,
                        data: input.data ?? undefined,
                    },
                    this.writeContext(!!user && !linked),
                );
            });
        });

        const updated = this.eventById(id)!;
        this.announce(existing.calendarId, SSEventType.CALENDAR_EVENT_UPDATED);

        // Only the organizer fans out invitations. An attendee editing their linked copy (guarded to
        // reminders/color above) must NOT bump SEQUENCE or send iMIP — doing so spoofs the attendee as
        // organizer AND outruns the organizer's SEQUENCE, so the RFC 5546 replay guard later drops the
        // organizer's real updates.
        if (user && !linked && updated.data?.attendees?.length) {
            propagateInvitation(this.home, updated, user, oldAttendees, updated.data.attendees).catch(console.error);
        }
        return updated;
    }

    public async deleteEvent(calendarId: string, id: string, user?: User): Promise<void> {
        const existing = this.eventById(id);
        // 404 (not 403) on calendar mismatch so a share on one calendar can't oracle event ids in another.
        if (!existing || existing.calendarId !== calendarId) throw new ApiError(404, 'Event not found');

        const invitation = isInvitationFromOthers(existing, this.home.user.email) ? existing.data : null;
        // Attendee deleting a linked copy = decline, and only an attendee has an RSVP to give: a file or a
        // CalDAV client can hang any ORGANIZER on an event, so a user who is not on the list just deletes
        // their row rather than telling a stranger they declined a meeting they were never invited to.
        const declining =
            user && invitation?.attendees?.some((a) => a.email.toLowerCase() === user.email.toLowerCase());
        if (user && declining && invitation?.organizer) {
            const orgUserId = invitation.organizer.userId;
            // A CalDAV- or iMIP-parsed organizer is known by address only; with no Eigen id to relay to,
            // the decline takes the same REPLY path an external organizer takes.
            if (!orgUserId || isExternalOwnerId(orgUserId)) {
                const mail = composeRsvpReply(existing, user.email, user.name ?? user.email, 'declined');
                sendMail(mail).catch(console.error);
            } else {
                propagateDecline(orgUserId, invitation.organizerEventId!, user.email).catch(console.error);
            }
        } else if (!invitation && existing.data?.attendees?.length) {
            // Organizer deleting = cancel for all attendees, which is what an event with no foreign
            // organizer makes this user.
            propagateCancellation(this.home, existing).catch(console.error);
        }

        const resource = this.resourceOf(id);
        if (!resource) throw new ApiError(404, 'Event not found');

        if (existing.parentEventId) {
            // Deleting one occurrence is a write of its master's file, never a delete of the resource.
            await this.gate.run(() =>
                this.editResource(resource, (component) => {
                    const key = existing.recurrenceDate ? storedRecurrenceKey(existing.recurrenceDate) : null;
                    if (key) removeExclusion(component, key, this.writeContext(true));
                }),
            );
        } else {
            await store.deleteResource(this, calendarId, resource.uri, { ifMatch: null });
        }
        this.announce(existing.calendarId, SSEventType.CALENDAR_EVENT_DELETED);
    }

    public async deleteByUri(calendarId: string, uri: string): Promise<void> {
        const event = await this.getEventByUri(calendarId, uri);
        if (!event) return;
        await this.deleteEvent(calendarId, event.id);
    }

    // Re-home a resource to another calendar of this same Home: one rename plus one transaction, so the
    // rows keep their identity and a linked invite is never declined on the organizer's behalf.
    public async moveEvent(calendarId: string, id: string, targetCalendarId: string): Promise<CalendarEvent> {
        const existing = this.eventById(id);
        if (!existing || existing.calendarId !== calendarId) throw new ApiError(404, 'Event not found');
        if (existing.parentEventId) throw new ApiError(400, 'Cannot move a single recurrence occurrence');
        if (targetCalendarId === calendarId) return existing;
        if (!this.calendarById(targetCalendarId)) throw new ApiError(404, 'Calendar not found');

        await this.gate.run(async () => {
            const resource = this.resourceOf(id);
            if (!resource) throw new ApiError(404, 'Event not found');
            // The target holding this UID would throw on its UNIQUE index after the rename.
            if (this.uidHolder(targetCalendarId, resource.uid)) {
                throw new ApiError(409, 'The target calendar already holds this event');
            }
            // A name the target already uses becomes a fresh one: a CalDAV client sees a delete plus a
            // create either way.
            const targetUri = store.resourceRowOf(this, targetCalendarId, resource.uri)
                ? `${randomUUID()}.ics`
                : resource.uri;
            await this.storage.moveDurable(
                resourcePath(calendarId, resource.uri),
                resourcePath(targetCalendarId, targetUri),
            );
            this.db.transaction((tx) => {
                const sourceCtag = this.bumpCtag(tx, calendarId);
                this.tombstone(tx, calendarId, resource.uri, resource.uriKey, sourceCtag);
                const targetCtag = this.bumpCtag(tx, targetCalendarId);
                // Moving A→B then B→A must not leave A listing the uri as both a 200 and a 404.
                tx.delete(schema.resourceTombstones)
                    .where(
                        and(
                            eq(schema.resourceTombstones.calendarId, targetCalendarId),
                            eq(schema.resourceTombstones.uriKey, uriKeyOf(targetUri)),
                        ),
                    )
                    .run();
                tx.update(schema.resources)
                    .set({
                        calendarId: targetCalendarId,
                        uri: targetUri,
                        uriKey: uriKeyOf(targetUri),
                        resourceCtag: targetCtag,
                    })
                    .where(eq(schema.resources.id, resource.id))
                    .run();
                tx.update(schema.events)
                    .set({ calendarId: targetCalendarId })
                    .where(eq(schema.events.resourceId, resource.id))
                    .run();
            });
        });

        this.announce(calendarId, SSEventType.CALENDAR_EVENT_UPDATED);
        this.announce(targetCalendarId, SSEventType.CALENDAR_EVENT_UPDATED);
        return this.eventById(id)!;
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
        _calendarColor: string,
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
        _calendarColor: string,
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

    private findLinkedEvent(orgEventId: string, orgUserId: string): CalendarEvent | null {
        const row = this.joinedEvents()
            .where(and(eq(schema.events.organizerEventId, orgEventId), eq(schema.events.organizerUserId, orgUserId)))
            .get();
        return row ? Calendar.toEvent(row) : null;
    }

    // The row shape of an invitation payload: the link rides in `data`, and only the fields a trusted
    // message stated ever reach it.
    private invitationInput(payload: ReceiveInvitationPayload): CreateEventArgs {
        return {
            title: payload.title,
            description: payload.description,
            location: payload.location,
            startTime: payload.startTime,
            endTime: payload.endTime,
            allDay: payload.allDay,
            rrule: payload.rrule,
            timezone: payload.timezone,
            status: payload.status,
            sequence: payload.sequence,
            dtstamp: payload.dtstamp,
            data: {
                ...payload.data,
                organizer: payload.data.organizer
                    ? { ...payload.data.organizer, userId: payload.organizerUserId }
                    : undefined,
                organizerEventId: payload.organizerEventId,
            },
            createByUserId: payload.createByUserId,
            uid: payload.uid,
        };
    }

    // Null when the invitation is dropped: the calendar already holds that UID under another link, which
    // is one organizer re-using a UID somebody else already sent us — never a second master.
    public async receiveInvitation(payload: ReceiveInvitationPayload): Promise<string | null> {
        const existing = this.findLinkedEvent(payload.organizerEventId, payload.organizerUserId);
        if (existing) return existing.id;

        const defaultCal = (await this.getCalendars()).find((c) => c.isDefault);
        if (!defaultCal) throw new ApiError(500, 'No default calendar');

        const created = await this.gate.run(async () => {
            if (this.uidHolder(defaultCal.id, payload.uid)) return null;
            return this.writeEvent(defaultCal.id, this.invitationInput(payload));
        });
        if (!created) {
            console.info(`calendar: dropped an invitation for ${payload.uid} — the calendar holds that UID already`);
            return null;
        }

        this.announce(defaultCal.id, SSEventType.CALENDAR_EVENT_CREATED);
        this.notifyInvitationReceived(payload);
        return created.id;
    }

    private notifyInvitationReceived(payload: ReceiveInvitationPayload): void {
        this.home.broadcast(buildCalendarEvent(SSEventType.CALENDAR_INVITE_RECEIVED, payload.organizerUserId));
        const organizer = payload.data?.organizer;
        this.home.notifications?.persist({
            type: 'calendar-invite',
            actorEmail: organizer?.email,
            title: `${actorDisplayName(organizer?.name, organizer?.email)} invited you`,
            body: payload.title,
            tag: `calendar-invite:${payload.organizerEventId}:${payload.startTime.getTime()}`,
            details: { startTime: payload.startTime.getTime() },
        });
    }

    public async receiveInvitationUpdate(
        orgEventId: string,
        orgUserId: string,
        payload: InvitationUpdatePayload,
    ): Promise<void> {
        const linked = await this.gate.run(async () => {
            const linked = this.findLinkedEvent(orgEventId, orgUserId);
            return linked && (await this.applyInvitationUpdate(linked, payload)) ? linked : null;
        });
        if (linked) this.notifyInvitationUpdated(linked, payload.title, payload.startTime, orgEventId, orgUserId);
    }

    // Caller holds the gate. False when the message is a replay the stored copy already outranks.
    private async applyInvitationUpdate(linked: CalendarEvent, payload: InvitationUpdatePayload): Promise<boolean> {
        const resource = this.resourceOf(linked.id);
        if (!resource) return false;
        const component = await this.loadResource(resource.calendarId, resource.uri);
        if (!component) return false;
        if (!isNewerRevision(payload, storedRevision(component, null))) return false;

        // Don't extend rrule beyond what the attendee has locally — they may have truncated it via
        // "delete this and following" and that intent should stick.
        const rrule = constrainRRule(payload.rrule, linked.rrule);
        // A redelivery patches to nothing, so it costs no ctag bump and tells the user nothing twice.
        const changed = patchEvent(
            component,
            null,
            this.invitationPatch(linked, payload, rrule),
            this.writeContext(false, payload.dtstamp),
        );
        if (!changed) return false;
        await store.writeResource(this, resource.calendarId, resource.uri, component, resource);
        return true;
    }

    // What an organizer's REQUEST is allowed to move on the attendee's copy.
    private invitationPatch(linked: CalendarEvent, payload: InvitationUpdatePayload, rrule: string | null): EventPatch {
        return {
            title: payload.title,
            description: payload.description,
            location: payload.location,
            startTime: payload.startTime,
            endTime: payload.endTime,
            allDay: payload.allDay,
            rrule: rrule ?? undefined,
            timezone: payload.timezone !== undefined ? payload.timezone : undefined,
            status: payload.status,
            data: payload.attendees ? { ...linked.data, attendees: payload.attendees } : undefined,
            // The attendee's copy carries the organizer's revision, so the replay guard has a number to
            // compare the next message against.
            sequence: payload.sequence,
        };
    }

    private notifyInvitationUpdated(
        linked: CalendarEvent,
        title: string,
        startTime: Date,
        orgEventId: string,
        orgUserId: string,
    ): void {
        this.home.broadcast(buildCalendarEvent(SSEventType.CALENDAR_INVITE_UPDATED, orgUserId));
        const organizer = linked.data?.organizer;
        this.home.notifications?.persist({
            type: 'calendar-invite-updated',
            actorEmail: organizer?.email,
            title: `${actorDisplayName(organizer?.name, organizer?.email)} updated an invitation`,
            body: title,
            tag: `calendar-invite:${orgEventId}:${startTime.getTime()}`,
            details: { startTime: startTime.getTime() },
        });
    }

    // Inbound iMIP: an external organizer moved ONE occurrence of a recurring invite (a lone VEVENT
    // with a RECURRENCE-ID). Land it as an exception on the linked series — feeding it to
    // receiveInvitationUpdate would rewrite the master and collapse the whole series.
    public async receiveInvitationException(
        orgEventId: string,
        orgUserId: string,
        payload: InvitationExceptionPayload,
    ): Promise<void> {
        const linked = this.findLinkedEvent(orgEventId, orgUserId);
        if (!linked) return;
        const applied = await this.gate.run(() => this.applyInvitationException(linked, payload));
        if (applied) this.home.broadcast(buildCalendarEvent(SSEventType.CALENDAR_INVITE_UPDATED, orgUserId));
    }

    // Caller holds the gate.
    private async applyInvitationException(
        linked: CalendarEvent,
        payload: InvitationExceptionPayload,
    ): Promise<boolean> {
        const recurrenceDate = this.recurrenceKeyForSeries(
            payload.recurrenceDate,
            payload.recurrenceInstant,
            linked.timezone,
        );
        const resource = this.resourceOf(linked.id);
        if (!resource) return false;
        const component = await this.loadResource(resource.calendarId, resource.uri);
        if (!component) return false;
        if (!isNewerRevision(payload, storedRevision(component, recurrenceDate))) return false;

        const existing = this.exceptionOf(linked.id, recurrenceDate);
        const data: EventData = {
            ...linked.data,
            attendees: payload.attendees ?? existing?.data?.attendees ?? linked.data?.attendees,
        };
        await this.writeEvent(linked.calendarId, {
            title: payload.title,
            description: payload.description,
            location: payload.location,
            startTime: payload.startTime,
            endTime: payload.endTime,
            allDay: payload.allDay,
            timezone: payload.timezone ?? linked.timezone,
            parentEventId: linked.id,
            recurrenceDate,
            status: payload.status,
            sequence: payload.sequence,
            dtstamp: payload.dtstamp,
            data,
            createByUserId: linked.createByUserId,
            uid: linked.uid,
        });
        return true;
    }

    // Re-key an inbound iMIP RECURRENCE-ID against the stored series' timezone. The payload is a single
    // VEVENT with no master, so the parser can't know the series tz; a UTC-Z RECURRENCE-ID (Exchange
    // clients, Eigen's own tz-null exceptions) would otherwise key on the UTC date and attach the
    // exception to the wrong occurrence. `recurrenceInstant` is set only for that Z-form case.
    private recurrenceKeyForSeries(
        recurrenceDate: string,
        recurrenceInstant: Date | null | undefined,
        tz: string | null,
    ): string {
        if (!recurrenceInstant || !tz) return recurrenceDate;
        const { year, month, day } = utcToLocal(recurrenceInstant, tz);
        const pad = (n: number) => String(n).padStart(2, '0');
        return `${year}-${pad(month)}-${pad(day)}`;
    }

    // The ONE decision an inbound iMIP REQUEST takes, made inside the gate against the state it would
    // overwrite: deliveries are concurrent HTTP requests, so a lookup outside it lets two of them file two
    // masters for one UID. `sender` is the DKIM-aligned From address the caller verified (R13 2c, R19).
    public async receiveImipRequest(parsed: ParsedEvent, sender: string): Promise<void> {
        const outcome = await this.gate.run(() => this.decideInboundRequest(parsed, sender));
        if (outcome.kind === 'dropped') {
            console.info(`iMIP: dropped a REQUEST for ${parsed.uid} from ${sender} — ${outcome.reason}`);
            return;
        }
        if (outcome.kind === 'created') {
            this.announce(outcome.calendarId, SSEventType.CALENDAR_EVENT_CREATED);
            this.notifyInvitationReceived(outcome.payload);
            return;
        }
        this.announce(outcome.linked.calendarId, SSEventType.CALENDAR_EVENT_UPDATED);
        this.notifyInvitationUpdated(
            outcome.linked,
            parsed.title,
            parsed.startTime,
            parsed.uid,
            externalOwnerId(sender),
        );
    }

    // Caller holds the gate.
    private async decideInboundRequest(parsed: ParsedEvent, sender: string): Promise<InboundRequestOutcome> {
        const stored = this.joinedEvents().where(eq(schema.events.uid, parsed.uid)).all().map(Calendar.toEvent);
        const linked = stored.find((e) => e.data?.organizer && e.data?.organizerEventId);

        if (linked) {
            // An update binds to the STORED organizer, not the one the body spells, so a co-attendee
            // cannot hijack the invitation.
            if (linked.data?.organizer?.email.toLowerCase() !== sender) {
                return { kind: 'dropped', reason: 'the sender is not the organizer this copy is linked to' };
            }
            // A single-occurrence move (Google/Outlook "this event" edit) attaches as an exception: a
            // full-event update would null the master's rrule and collapse the whole series (audit #A).
            const applied = parsed.recurrenceDate
                ? await this.applyInvitationException(linked, inboundExceptionPayload(parsed))
                : await this.applyInvitationUpdate(linked, inboundUpdatePayload(parsed));
            return applied ? { kind: 'updated', linked } : { kind: 'dropped', reason: 'nothing newer to apply' };
        }

        const master = stored.find((e) => !e.parentEventId);
        if (master) {
            // An event this Home already holds under nobody's link: the organizer may claim it, but only
            // when the address it names is the verified sender (R19).
            const resource = this.resourceOf(master.id);
            const component = resource ? await this.loadResource(resource.calendarId, resource.uri) : null;
            if (!component || storedOrganizerAddress(component) !== sender) {
                return { kind: 'dropped', reason: 'the stored event names another organizer' };
            }
            if (parsed.recurrenceDate) {
                return { kind: 'dropped', reason: 'an occurrence of a series nobody organizes here yet' };
            }
            await this.adoptAsInvitation(master, resource!, component, parsed, sender);
            return { kind: 'updated', linked: master };
        }

        // A new invitation is attributed to its sender, so the body's ORGANIZER must be that address.
        if (parsed.data?.organizer?.email?.toLowerCase() !== sender) {
            return { kind: 'dropped', reason: 'the ICS organizer is not the sender' };
        }
        // A lone exception REQUEST with no known master has nothing to attach to.
        if (parsed.recurrenceDate) return { kind: 'dropped', reason: 'an exception with no series' };

        const defaultCal = this.db
            .select()
            .from(schema.calendars)
            .all()
            .find((row) => row.isDefault);
        if (!defaultCal) return { kind: 'dropped', reason: 'no default calendar' };
        const payload = inboundInvitationPayload(parsed, sender);
        await this.writeEvent(defaultCal.id, this.invitationInput(payload));
        return { kind: 'created', calendarId: defaultCal.id, payload };
    }

    // Caller holds the gate. The stored resource becomes the attendee-side copy of the organizer's event:
    // same file, same row ids, the link and the guest list from the message.
    private async adoptAsInvitation(
        master: CalendarEvent,
        resource: typeof schema.resources.$inferSelect,
        component: ICAL.Component,
        parsed: ParsedEvent,
        sender: string,
    ): Promise<void> {
        const organizer = { userId: externalOwnerId(sender), email: sender, name: parsed.data?.organizer?.name };
        stampInvitationLink(component, { organizerEventId: parsed.uid, organizerUserId: organizer.userId });
        patchEvent(
            component,
            null,
            {
                ...this.invitationPatch(master, inboundUpdatePayload(parsed), parsed.rrule),
                data: { ...master.data, organizer, attendees: parsed.data?.attendees },
            },
            this.writeContext(false, parsed.dtstamp),
        );
        await store.writeResource(this, resource.calendarId, resource.uri, component, resource);
    }

    // Inbound iMIP: an external organizer canceled ONE occurrence of a recurring invite. Cancel just
    // that instance — removeInvitation would delete the attendee's entire linked series.
    public async cancelInvitationOccurrence(
        orgEventId: string,
        orgUserId: string,
        recurrenceDate: string,
        recurrenceInstant: Date | null | undefined,
        revision: Revision,
    ): Promise<void> {
        const cancelled = await this.gate.run(async () => {
            const linked = this.findLinkedEvent(orgEventId, orgUserId);
            if (!linked) return false;
            const resource = this.resourceOf(linked.id);
            if (!resource) return false;
            const component = await this.loadResource(resource.calendarId, resource.uri);
            if (!component) return false;
            const key = this.recurrenceKeyForSeries(recurrenceDate, recurrenceInstant, linked.timezone);
            if (!isNewerRevision(revision, storedRevision(component, key))) return false;
            await this.removeOccurrence(linked.id, key, revision);
            return true;
        });
        if (cancelled) this.home.broadcast(buildCalendarEvent(SSEventType.CALENDAR_INVITE_CANCELLED, orgUserId));
    }

    public async removeInvitation(orgEventId: string, orgUserId: string): Promise<void> {
        const linked = this.findLinkedEvent(orgEventId, orgUserId);
        if (!linked) return;
        const resource = this.resourceOf(linked.id);
        if (!resource) return;

        await store.deleteResource(this, linked.calendarId, resource.uri, { ifMatch: null });
        this.home.broadcast(buildCalendarEvent(SSEventType.CALENDAR_INVITE_CANCELLED, orgUserId));
        const organizer = linked.data?.organizer;
        this.home.notifications?.persist({
            type: 'calendar-invite-cancelled',
            actorEmail: organizer?.email,
            title: `${actorDisplayName(organizer?.name, organizer?.email)} canceled an invitation`,
            body: linked.title,
            tag: `calendar-invite:${orgEventId}:${linked.startTime.getTime()}`,
        });
    }

    public async updateAttendeeStatus(eventId: string, email: string, status: Attendee['status']): Promise<void> {
        const event = this.eventById(eventId);
        if (!event?.data?.attendees) return;
        const resource = this.resourceOf(eventId);
        if (!resource) return;

        const attendees = event.data.attendees.map((a) =>
            a.email.toLowerCase() === email.toLowerCase() ? { ...a, status } : a,
        );
        const key = event.recurrenceDate ? storedRecurrenceKey(event.recurrenceDate) : null;
        await this.gate.run(() =>
            this.editResource(resource, (component) => {
                patchEvent(component, key, { data: { ...event.data, attendees } }, this.writeContext(false));
            }),
        );
    }

    // `restoreCancelled` distinguishes the two sides of an occurrence RSVP: an attendee re-accepting
    // their own removed occurrence un-cancels their linked copy (default), while organizer-side
    // receivers (iMIP REPLY, relay RSVP) may only move PARTSTAT — never resurrect an occurrence the
    // organizer deleted (RFC 5546).
    public async rsvpForOccurrence(
        eventId: string,
        email: string,
        status: Attendee['status'],
        recurrenceDate: string,
        recurrenceInstant?: Date | null,
        restoreCancelled = true,
    ): Promise<void> {
        const parent = this.eventById(eventId);
        if (!parent) throw new ApiError(404, 'Event not found');

        const key = this.recurrenceKeyForSeries(recurrenceDate, recurrenceInstant, parent.timezone);
        const existing = this.exceptionOf(eventId, key);
        // An occurrence the organizer deleted is an EXDATE, which carries no attendee list: there is
        // nowhere to record a PARTSTAT for an instance that no longer exists.
        if (existing?.status === 'cancelled' && !restoreCancelled) return;
        const data = existing?.data ?? parent.data ?? {};
        // Only recorded invitees may leave a PARTSTAT — inbound iMIP routes occurrence REPLYs here, and
        // an uninvited sender must not mutate rows. Someone can be invited to a single occurrence only.
        const invitees = data.attendees ?? parent.data?.attendees ?? [];
        if (!invitees.some((a) => a.email.toLowerCase() === email.toLowerCase())) return;
        const attendees = invitees.map((a) => (a.email.toLowerCase() === email.toLowerCase() ? { ...a, status } : a));

        if (existing && existing.status !== 'cancelled') {
            const resource = this.resourceOf(existing.id);
            if (!resource) return;
            await this.gate.run(() =>
                this.editResource(resource, (component) => {
                    patchEvent(component, key, { data: { ...data, attendees } }, this.writeContext(false));
                }),
            );
            return;
        }

        const { startTime, endTime } = computeOccurrenceTimes(parent, key);
        await this.createEvent(parent.calendarId, {
            title: existing?.title ?? parent.title,
            description: parent.description,
            location: parent.location,
            startTime: existing?.startTime ?? startTime,
            endTime: existing?.endTime ?? endTime,
            allDay: parent.allDay,
            timezone: parent.timezone,
            parentEventId: eventId,
            recurrenceDate: key,
            status: existing && !restoreCancelled ? 'cancelled' : 'confirmed',
            data: { ...data, attendees },
            createByUserId: parent.createByUserId,
            uid: parent.uid,
        });
    }

    // Caller holds the gate. `revision` is set on the iMIP CANCEL path so the exclusion records what the
    // CANCEL stated and the ordering rule can reject stale REQUEST/CANCEL redeliveries against it.
    private async removeOccurrence(eventId: string, recurrenceDate: string, revision?: Revision): Promise<void> {
        const parent = this.eventById(eventId);
        if (!parent) throw new ApiError(404, 'Event not found');
        const { startTime, endTime } = computeOccurrenceTimes(parent, recurrenceDate);
        await this.writeEvent(parent.calendarId, {
            title: parent.title,
            startTime,
            endTime,
            allDay: parent.allDay,
            timezone: parent.timezone,
            parentEventId: eventId,
            recurrenceDate,
            status: 'cancelled',
            sequence: revision?.sequence,
            dtstamp: revision?.dtstamp,
            uid: parent.uid,
        });
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
        const event = this.eventById(eventId);
        if (!event) throw new ApiError(404, 'Event not found');
        if (!event.data?.organizer || !isInvitationFromOthers(event, this.home.user.email)) {
            throw new ApiError(400, 'Not a linked event');
        }

        const isAttendee = event.data.attendees?.some((a) => a.email.toLowerCase() === user.email.toLowerCase());
        if (!isAttendee) throw new ApiError(403, 'Not an attendee');

        const scope = input.scope || 'all';
        const organizerUserId = event.data.organizer.userId;
        const organizerEventId = event.data.organizerEventId!;
        const isExternalOrganizer = isExternalOwnerId(organizerUserId);

        const sendRsvpReply = (status: Attendee['status'], recurrenceDate?: string) => {
            const mail = composeRsvpReply(event, user.email, user.name ?? user.email, status, recurrenceDate);
            sendMail(mail).catch(console.error);
        };

        if (scope === 'this' && input.recurrenceDate) {
            const recurrenceDate = input.recurrenceDate;
            const status = input.remove ? 'declined' : input.status;
            if (input.remove) {
                await this.gate.run(() => this.removeOccurrence(eventId, recurrenceDate));
                this.announce(event.calendarId, SSEventType.CALENDAR_EVENT_UPDATED);
            } else {
                await this.rsvpForOccurrence(eventId, user.email, input.status, recurrenceDate);
            }
            if (isExternalOrganizer) {
                sendRsvpReply(status, recurrenceDate);
            } else {
                propagateRsvp(organizerUserId, organizerEventId, user.email, status, recurrenceDate).catch(
                    console.error,
                );
            }
        } else if (scope === 'this-and-following' && input.remove && input.recurrenceDate) {
            await this.removeThisAndFuture(eventId, input.recurrenceDate);
            if (isExternalOrganizer) sendRsvpReply('declined');
            else propagateRsvp(organizerUserId, organizerEventId, user.email, 'declined').catch(console.error);
        } else if (input.remove) {
            await this.deleteEvent(event.calendarId, eventId, user);
        } else {
            await this.updateAttendeeStatus(eventId, user.email, input.status);
            if (isExternalOrganizer) sendRsvpReply(input.status);
            else propagateRsvp(organizerUserId, organizerEventId, user.email, input.status).catch(console.error);
        }
    }

    private async removeThisAndFuture(eventId: string, recurrenceDate: string): Promise<void> {
        const event = this.eventById(eventId);
        if (!event) throw new ApiError(404, 'Event not found');
        if (!event.rrule) throw new ApiError(400, 'Not a recurring event');
        const truncated = truncateRRule(event.rrule, new Date(`${recurrenceDate}T00:00:00Z`));

        const resource = this.resourceOf(eventId);
        if (!resource) throw new ApiError(404, 'Event not found');
        await this.gate.run(() =>
            this.editResource(resource, (component) => {
                patchEvent(component, null, { rrule: truncated }, this.writeContext(false));
            }),
        );
    }
}
