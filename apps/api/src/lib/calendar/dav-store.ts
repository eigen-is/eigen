import { randomUUID } from 'node:crypto';
import { and, eq, gt, inArray, or } from 'drizzle-orm';
import type ICAL from 'ical.js';
import { enforceHomeDataQuota } from '../config/enforcement';
import {
    ApiError,
    computeResourceEtag,
    type DeleteResourceResult,
    matchesIfMatch,
    matchesIfNoneMatch,
    normalizeResourceUri,
    type PutResourceResult,
} from '../core';
import { parseResource, projectResource, restampResource, serializeResource, stripEigenStamps } from '../ical';
import { EIGEN, readStamp, recurrenceKeyOf, seriesTimezones, uidOf } from '../ical/ical-parse';
import type { Calendar } from './calendar';
import type { EventRowInput } from './resource-store';
import { EVENT_MAX_BYTES, resourceBytes, sanitizeCalendarId, sanitizeEventUri } from './resource-store';
import * as schema from './schema';

// The CalDAV store seam over the Calendar facade. See docs/CALENDAR.md § CalDAV surface.

// The size lets a REPORT weigh a row against its byte budget before reading the bytes at all.
export type ResourceRow = {
    id: string;
    uri: string;
    uid: string;
    etag: string;
    size: number;
    hasUnindexedRecurrence: boolean;
};

const RESOURCE_ROW = {
    id: schema.resources.id,
    uri: schema.resources.uri,
    uid: schema.resources.uid,
    etag: schema.resources.etag,
    size: resourceBytes,
    hasUnindexedRecurrence: schema.resources.hasUnindexedRecurrence,
};

// What one commit writes: the resource's own columns plus every event row its bytes project to.
export type ResourceCommit = {
    id: string;
    calendarId: string;
    uri: string;
    uid: string;
    ics: Buffer;
    etag: string;
    rows: EventRowInput[];
    hasUnindexedRecurrence: boolean;
};

// A uri is unique as written within its calendar; only the Unicode form is folded, so an NFD href still finds its row.
const atUri = (calendarId: string, uri: string) =>
    and(eq(schema.resources.calendarId, calendarId), eq(schema.resources.uri, normalizeResourceUri(uri)));

// The rows a file projects to, ids from its `X-EIGEN-EVENT-ID` lines: one stored id belongs to one row.
export function projectRows(
    calendarId: string,
    resourceId: string,
    resource: ICAL.Component,
): { rows: EventRowInput[]; hasUnindexedRecurrence: boolean; skipped: number; duplicateMaster: boolean } {
    const projected = projectResource(resource);
    const now = new Date();
    const claimed = new Set<string>();
    const identified = projected.events.map((event) => {
        const id = event.eventId && !claimed.has(event.eventId) ? event.eventId : randomUUID();
        claimed.add(id);
        return { event, id };
    });

    // A master leads its overrides whatever order the file lists them in; a second master is malformed, the first still leads.
    const masterIdByUid = new Map<string, string>();
    let duplicateMaster = false;
    for (const { event, id } of identified) {
        if (event.recurrenceDate !== null) continue;
        if (masterIdByUid.has(event.uid)) duplicateMaster = true;
        else masterIdByUid.set(event.uid, id);
    }

    const rows = identified.map(({ event, id }) => ({
        id,
        resourceId,
        calendarId,
        uid: event.uid,
        title: event.title,
        description: event.description,
        location: event.location,
        startTime: event.startTime,
        endTime: event.endTime,
        allDay: event.allDay,
        rrule: event.rrule,
        timezone: event.timezone,
        parentEventId: event.recurrenceDate === null ? null : (masterIdByUid.get(event.uid) ?? null),
        recurrenceDate: event.recurrenceDate,
        status: event.status,
        data: event.data,
        organizerEventId: event.data?.organizerEventId ?? null,
        organizerUserId: event.data?.organizer?.userId || null,
        sequence: event.sequence,
        createByUserId: event.createByUserId,
        createdAt: event.createdAt ?? now,
        updatedAt: event.updatedAt ?? now,
    }));

    return {
        rows,
        hasUnindexedRecurrence: projected.hasUnindexedRecurrence,
        skipped: projected.skipped,
        duplicateMaster,
    };
}

// ---- Index reads: what the protocol handlers sit on ----

// The reads stay async where the shape looks synchronous, so the DAV layer above them is untouched.

export function resourceRowOf(calendar: Calendar, calendarId: string, uri: string): ResourceRow | null {
    return calendar.db.select(RESOURCE_ROW).from(schema.resources).where(atUri(calendarId, uri)).get() ?? null;
}

export async function getResourceMeta(
    calendar: Calendar,
    calendarId: string,
    uri: string,
): Promise<ResourceRow | null> {
    return resourceRowOf(calendar, calendarId, uri);
}

export async function listResources(calendar: Calendar, calendarId: string): Promise<ResourceRow[]> {
    return calendar.db
        .select(RESOURCE_ROW)
        .from(schema.resources)
        .where(eq(schema.resources.calendarId, calendarId))
        .all();
}

export async function getResourcesByUris(
    calendar: Calendar,
    calendarId: string,
    uris: string[],
): Promise<ResourceRow[]> {
    if (!uris.length) return [];
    return calendar.db
        .select(RESOURCE_ROW)
        .from(schema.resources)
        .where(
            and(
                eq(schema.resources.calendarId, calendarId),
                inArray(schema.resources.uri, uris.map(normalizeResourceUri)),
            ),
        )
        .all();
}

// A resource the index cannot expand (stripped rule, RDATE) may still have occurrences in range, so it joins every match.
export async function getResourcesInRange(
    calendar: Calendar,
    calendarId: string,
    matched: string[],
): Promise<ResourceRow[]> {
    const unindexed = eq(schema.resources.hasUnindexedRecurrence, true);
    return calendar.db
        .select(RESOURCE_ROW)
        .from(schema.resources)
        .where(
            and(
                eq(schema.resources.calendarId, calendarId),
                matched.length
                    ? or(inArray(schema.resources.uri, matched.map(normalizeResourceUri)), unindexed)
                    : unindexed,
            ),
        )
        .all();
}

// The resources changed after collection token N — one indexed scan, the sync-collection delta.
export async function getChangedResourcesSince(
    calendar: Calendar,
    calendarId: string,
    sinceCtag: number,
): Promise<ResourceRow[]> {
    return calendar.db
        .select(RESOURCE_ROW)
        .from(schema.resources)
        .where(and(eq(schema.resources.calendarId, calendarId), gt(schema.resources.resourceCtag, sinceCtag)))
        .all();
}

export async function getDeletedResourcesSince(
    calendar: Calendar,
    calendarId: string,
    sinceCtag: number,
): Promise<{ uri: string }[]> {
    return calendar.db
        .select({ uri: schema.resourceTombstones.uri })
        .from(schema.resourceTombstones)
        .where(
            and(
                eq(schema.resourceTombstones.calendarId, calendarId),
                gt(schema.resourceTombstones.deletedAtCtag, sinceCtag),
            ),
        )
        .all();
}

// ---- Bytes ----

// Body and validator are one row by construction: the etag was hashed from these very bytes at the write.
export async function getResource(
    calendar: Calendar,
    calendarId: string,
    uri: string,
): Promise<{ bytes: Uint8Array; etag: string } | null> {
    const row = calendar.db
        .select({ ics: schema.resources.ics, etag: schema.resources.etag })
        .from(schema.resources)
        .where(atUri(calendarId, uri))
        .get();
    return row ? { bytes: row.ics, etag: row.etag } : null;
}

// ---- Writes ----

export type PreparedResource = {
    id: string;
    uid: string;
    text: string;
    bytes: Buffer;
    etag: string;
    rows: EventRowInput[];
    hasUnindexedRecurrence: boolean;
    skipped: number;
    duplicateMaster: boolean;
};

export function prepareResource(
    calendarId: string,
    resource: ICAL.Component,
    existingId: string | null,
): PreparedResource {
    const id = existingId ?? randomUUID();
    const text = serializeResource(resource);
    const bytes = Buffer.from(new TextEncoder().encode(text));
    return {
        id,
        uid: uidOfResource(resource),
        text,
        bytes,
        etag: computeResourceEtag(bytes),
        ...projectRows(calendarId, id, resource),
    };
}

export function writeResource(
    calendar: Calendar,
    calendarId: string,
    uri: string,
    resource: ICAL.Component,
    existing: { id: string; size: number } | null,
): Promise<void> {
    return writePrepared(
        calendar,
        calendarId,
        uri,
        prepareResource(calendarId, resource, existing?.id ?? null),
        existing,
    );
}

// The one write every resource path takes: both ceilings judge the bytes right before the transaction that
// stores them, so a refusal leaves the calendar as it was. `existing` is the resource this one replaces, or a
// rewrite that shrinks a resource would be refused on a quota its own bytes already hold.
export async function writePrepared(
    calendar: Calendar,
    calendarId: string,
    uri: string,
    prepared: PreparedResource,
    existing: { id: string; size: number } | null,
): Promise<void> {
    if (prepared.bytes.byteLength > EVENT_MAX_BYTES) throw new ApiError(413, 'Event is too large');
    if (calendar.meteredIngest) {
        await enforceHomeDataQuota(calendar.home.user.id, prepared.bytes.byteLength, existing?.size ?? 0);
    }
    calendar.commitResource({
        id: prepared.id,
        calendarId,
        uri,
        uid: prepared.uid,
        ics: prepared.bytes,
        etag: prepared.etag,
        rows: prepared.rows,
        hasUnindexedRecurrence: prepared.hasUnindexedRecurrence,
    });
}

// A UID travels into etags and sync deltas, so an unprintable or endless one is refused rather than stored.
const MAX_UID_LENGTH = 255;
function isStorableUid(uid: string): boolean {
    if (uid.length > MAX_UID_LENGTH) return false;
    for (let index = 0; index < uid.length; index++) {
        const code = uid.charCodeAt(index);
        if (code < 0x20 || code === 0x7f) return false;
    }
    return true;
}

export function uidOfResource(resource: ICAL.Component): string {
    return uidOf(resource.getAllSubcomponents('vevent')[0]);
}

// A copy of somebody else's event: the server's own organizer stamp says so, where the ORGANIZER address is the client's to spell.
function isLinkedCopy(stored: ICAL.Component): boolean {
    return stored.getAllSubcomponents('vevent').some((vevent) => readStamp(vevent, EIGEN.organizerEvent) !== null);
}

function adoptAlarms(stored: ICAL.Component, incoming: ICAL.Component): void {
    const incomingVEvents = incoming.getAllSubcomponents('vevent');
    const zones = seriesTimezones(incomingVEvents);
    const byKey = new Map(
        incomingVEvents.map((v) => [`${uidOf(v)}|${recurrenceKeyOf(v, zones.get(uidOf(v)) ?? null) ?? ''}`, v]),
    );
    const storedVEvents = stored.getAllSubcomponents('vevent');
    const storedZones = seriesTimezones(storedVEvents);
    for (const vevent of storedVEvents) {
        const uid = uidOf(vevent);
        const match = byKey.get(`${uid}|${recurrenceKeyOf(vevent, storedZones.get(uid) ?? null) ?? ''}`);
        if (!match) continue;
        vevent.removeAllSubcomponents('valarm');
        for (const alarm of match.getAllSubcomponents('valarm')) {
            // The one write path that keeps a client's own subcomponents: its Eigen lines are still untrusted.
            stripEigenStamps(alarm);
            vevent.addSubcomponent(alarm);
        }
    }
}

export type PutResourceOptions = {
    ifMatch: string | null;
    ifNoneMatch: string | null;
    actor?: string | null;
    // Set by a whole-file import alone: it files one UID once per Home, where a device owns only the calendar it syncs.
    import?: { organizer: string | null };
};

// Preconditions, UID rules, re-stamping and the linked-copy restriction are decided inside the lock, against the state overwritten.
export async function putResource(
    calendar: Calendar,
    calendarId: string,
    uri: string,
    body: string,
    options: PutResourceOptions,
): Promise<PutResourceResult> {
    if (sanitizeCalendarId(calendarId) !== calendarId) return { ok: false, error: 'invalid' };
    if (sanitizeEventUri(uri) !== uri) return { ok: false, error: 'invalid' };

    // Bounded before any parse, so a hostile payload never reaches the component builder.
    if (Buffer.byteLength(body) > EVENT_MAX_BYTES) return { ok: false, error: 'too-large' };

    // The body says nothing about stored state, so a 5 MiB parse waits for no other writer.
    let incoming: ICAL.Component;
    try {
        incoming = parseResource(body);
    } catch {
        return { ok: false, error: 'invalid', reason: 'data', message: 'invalid iCalendar data' };
    }

    const vevents = incoming.getAllSubcomponents('vevent');
    if (!vevents.length) return { ok: false, error: 'invalid', reason: 'component', message: 'no VEVENT found' };
    // One resource is one series: a second UID's overrides would otherwise hang off this master.
    const uids = new Set(vevents.map(uidOf));
    if (uids.size > 1) return { ok: false, error: 'invalid', reason: 'object', message: 'one UID per resource' };
    const uid = [...uids][0];
    if (!uid) return { ok: false, error: 'invalid', reason: 'data', message: 'UID is required' };
    if (!isStorableUid(uid)) return { ok: false, error: 'invalid', reason: 'data', message: 'UID is not storable' };

    return calendar.writeLock.run(async (): Promise<PutResourceResult> => {
        // Sanitizing an id is not knowing it exists, and a write would otherwise file a resource under nobody's calendar.
        if (!calendar.calendarRow(calendarId)) return { ok: false, error: 'no-collection' };

        // Two racing If-Match PUTs serialize through the lock, so the loser sees the winner's new etag here.
        const existing = calendar.db
            .select({
                id: schema.resources.id,
                uid: schema.resources.uid,
                ics: schema.resources.ics,
                etag: schema.resources.etag,
                size: resourceBytes,
            })
            .from(schema.resources)
            .where(atUri(calendarId, uri))
            .get();
        const currentEtag = existing ? `"${existing.etag}"` : null;
        if (options.ifNoneMatch !== null && matchesIfNoneMatch(options.ifNoneMatch, currentEtag)) {
            return { ok: false, error: 'precondition' };
        }
        if (options.ifMatch !== null && !matchesIfMatch(options.ifMatch, currentEtag)) {
            return { ok: false, error: 'precondition' };
        }

        // Inside the lock, or two writers of one UID both read "nobody holds it" and the UNIQUE index 500s.
        const holder = calendar.db
            .select({ id: schema.resources.id, uri: schema.resources.uri })
            .from(schema.resources)
            .where(
                options.import
                    ? eq(schema.resources.uid, uid)
                    : and(eq(schema.resources.calendarId, calendarId), eq(schema.resources.uid, uid)),
            )
            .get();
        if (holder && holder.id !== existing?.id) return { ok: false, error: 'uid-conflict', conflictUri: holder.uri };
        if (existing && uid !== existing.uid) return { ok: false, error: 'uid-conflict' };

        // The stored bytes decide the linked-copy rule, the stamps to carry over and the no-op below.
        const storedBytes = existing?.ics ?? null;
        const stored = storedBytes ? parseResource(new TextDecoder().decode(storedBytes)) : null;

        let resource: ICAL.Component;
        if (stored && isLinkedCopy(stored)) {
            adoptAlarms(stored, incoming);
            resource = stored;
        } else {
            // Nothing the body says about an Eigen line is trusted: the stamps come back from the stored resource.
            restampResource(incoming, stored, {
                createByUserId: stored ? undefined : (options.actor ?? undefined),
                importedOrganizer: stored ? undefined : (options.import?.organizer ?? undefined),
            });
            resource = incoming;
        }

        // Prepared once here: the write below lands exactly the rows, bytes and hash these refusals judged.
        const prepared = prepareResource(calendarId, resource, existing?.id ?? null);
        // A PUT is all-or-nothing: one unreadable VEVENT makes the payload malformed, where an import drops that member and keeps going.
        if (prepared.skipped || prepared.duplicateMaster) {
            return { ok: false, error: 'invalid', reason: 'object', message: 'invalid iCalendar data' };
        }
        // A zero-length event is legal (RFC 5545 §3.6.1); one that ends before it starts is refused here as on the REST write.
        if (prepared.rows.some((row) => row.endTime < row.startTime)) {
            return { ok: false, error: 'invalid', reason: 'data', message: 'event ends before it starts' };
        }

        // A client whose bytes are not what got stored has nothing to attach a validator to (RFC 4791 § 5.3.4).
        const validator = prepared.text === body ? prepared.etag : null;

        // Judged on the bytes, never the row: rewriting an unchanged resource bumps the ctag and resyncs every client for nothing.
        if (storedBytes && prepared.etag === computeResourceEtag(storedBytes)) {
            return { ok: true, etag: validator, created: false };
        }

        // Size and quota are only known once the stamps and stored alarms decided the bytes, so both map to protocol errors here, not a 500.
        try {
            // sanitizeEventUri already accepted this spelling, so the stored uri is the NFC one.
            await writePrepared(calendar, calendarId, uri, prepared, existing ?? null);
        } catch (e) {
            if (e instanceof ApiError && e.status === 413) return { ok: false, error: 'too-large' };
            if (e instanceof ApiError && e.status === 507) return { ok: false, error: 'quota' };
            // The same answer a create gets when the name is taken: the client re-reads and picks another.
            if (e instanceof ApiError && e.status === 412) return { ok: false, error: 'precondition' };
            throw e;
        }

        return { ok: true, etag: validator, created: !existing };
    });
}

// An unknown uri is a 404, deliberately unlike REST's idempotent no-op.
export async function deleteResource(
    calendar: Calendar,
    calendarId: string,
    uri: string,
    pre: { ifMatch: string | null },
): Promise<DeleteResourceResult> {
    return calendar.writeLock.run(async (): Promise<DeleteResourceResult> => {
        const row = calendar.db
            .select({
                id: schema.resources.id,
                calendarId: schema.resources.calendarId,
                uri: schema.resources.uri,
                etag: schema.resources.etag,
            })
            .from(schema.resources)
            .where(atUri(calendarId, uri))
            .get();
        if (!row) return { ok: false, error: 'not-found' };
        if (pre.ifMatch !== null && !matchesIfMatch(pre.ifMatch, `"${row.etag}"`)) {
            return { ok: false, error: 'precondition' };
        }
        await calendar.purgeResource(row);
        return { ok: true };
    });
}
