import { randomUUID } from 'node:crypto';
import { and, eq, gt, inArray } from 'drizzle-orm';
import type ICAL from 'ical.js';
import { enforceHomeDataQuota } from '../config/enforcement';
import {
    ApiError,
    computeResourceEtag,
    type DeleteResourceResult,
    matchesIfMatch,
    matchesIfNoneMatch,
    type PutResourceResult,
    readResourceFile,
    uriKeyOf,
    writeResourceFile,
} from '../core';
import { parseResource, projectResource, restampResource, serializeResource, stripEigenStamps } from '../ical';
import { EIGEN, readStamp, recurrenceKeyOf, seriesTimezones, uidOf } from '../ical/ical-parse';
import type { Calendar } from './calendar';
import type { EventRowInput } from './resource-store';
import { EVENT_MAX_BYTES, gateKey, resourcePath, sanitizeCalendarId, sanitizeEventUri } from './resource-store';
import * as schema from './schema';

// The store seam over the Calendar facade: one file per UID, the index behind it. Every mutation runs inside
// the write gate against the state it overwrites; every read drains a torn pair first.

// The index projection the DAV layer reads for a resource; the etag is the hash the handler quotes.
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
    size: schema.resources.size,
    hasUnindexedRecurrence: schema.resources.hasUnindexedRecurrence,
};

// What one commit writes: the resource's own columns plus every event row the file projects to.
export type ResourceCommit = {
    id: string;
    calendarId: string;
    uri: string;
    uid: string;
    etag: string;
    mtime: number;
    size: number;
    rows: EventRowInput[];
    hasUnindexedRecurrence: boolean;
};

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

    // A master leads its own overrides, whatever order the file lists them in. One UID has one master, so
    // a second one is a malformed resource the first still leads.
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

export function resourceRowOf(calendar: Calendar, calendarId: string, uri: string): ResourceRow | null {
    return (
        calendar.db
            .select(RESOURCE_ROW)
            .from(schema.resources)
            .where(and(eq(schema.resources.calendarId, calendarId), eq(schema.resources.uriKey, uriKeyOf(uri))))
            .get() ?? null
    );
}

export async function getResourceMeta(
    calendar: Calendar,
    calendarId: string,
    uri: string,
): Promise<ResourceRow | null> {
    await calendar.gate.ensureDrained();
    return resourceRowOf(calendar, calendarId, uri);
}

export async function listResources(calendar: Calendar, calendarId: string): Promise<ResourceRow[]> {
    await calendar.gate.ensureDrained();
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
    await calendar.gate.ensureDrained();
    return calendar.db
        .select(RESOURCE_ROW)
        .from(schema.resources)
        .where(and(eq(schema.resources.calendarId, calendarId), inArray(schema.resources.uriKey, uris.map(uriKeyOf))))
        .all();
}

// The resources changed after collection token N — one indexed scan, the sync-collection delta.
export async function getChangedResourcesSince(
    calendar: Calendar,
    calendarId: string,
    sinceCtag: number,
): Promise<ResourceRow[]> {
    await calendar.gate.ensureDrained();
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
    await calendar.gate.ensureDrained();
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

// Hashing the bytes just read keeps body and validator one revision; a durably stale row would otherwise
// 412 every conditional write forever.
export async function getResource(
    calendar: Calendar,
    calendarId: string,
    uri: string,
): Promise<{ bytes: Uint8Array; etag: string } | null> {
    await calendar.gate.ensureDrained();
    const row = resourceRowOf(calendar, calendarId, uri);
    if (!row) return null;
    const bytes = await readResourceFile(calendar.storage, resourcePath(calendarId, row.uri));
    if (!bytes) {
        calendar.gate.markDirty(gateKey(calendarId, row.uri));
        return null;
    }
    const etag = computeResourceEtag(bytes);
    if (etag !== row.etag) calendar.gate.markDirty(gateKey(calendarId, row.uri));
    return { bytes, etag };
}

// ---- Writes ----

// What a write computes before it can land: the rows the file projects to, the bytes that would be stored
// and their hash. Whoever judges a resource before writing it prepares it once and writes that.
export type PreparedResource = {
    id: string;
    uid: string;
    text: string;
    bytes: Uint8Array;
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
    const bytes = new TextEncoder().encode(text);
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

// The one pair of file write + index commit. The caller holds the gate and owns the component; a throw
// anywhere after the rename leaves the key dirty for the next drain.
export async function writePrepared(
    calendar: Calendar,
    calendarId: string,
    uri: string,
    prepared: PreparedResource,
    existing: { id: string; size: number } | null,
): Promise<void> {
    // Both ceilings hold on the bytes that would land, before any write intent is recorded, so a refusal
    // leaves nothing for a drain to chase. The stored resource's size is the credit the edit grace reads.
    if (prepared.bytes.byteLength > EVENT_MAX_BYTES) throw new ApiError(413, 'Event is too large');
    if (calendar.meteredIngest) {
        await enforceHomeDataQuota(calendar.home.user.id, prepared.bytes.byteLength, existing?.size ?? 0);
    }
    // A name no row holds can still be a file: a dedupe loser, an unparseable resource, a calendar whose
    // index phase threw. A create that replaced it would destroy bytes nothing carries any more.
    if (!existing && (await calendar.storage.exists(resourcePath(calendarId, uri)))) {
        throw new ApiError(412, 'A file already exists under this name');
    }

    try {
        // Only a replacement can land bytes a later stat diff cannot see; a new name is always visible.
        if (existing) calendar.recordPendingWrite(calendarId, uri);
        const { mtime, size } = await writeResourceFile(
            calendar.storage,
            resourcePath(calendarId, uri),
            prepared.bytes,
        );
        calendar.commitResource({
            id: prepared.id,
            calendarId,
            uri,
            uid: prepared.uid,
            etag: prepared.etag,
            mtime,
            size,
            rows: prepared.rows,
            hasUnindexedRecurrence: prepared.hasUnindexedRecurrence,
        });
        calendar.eventsBytes += size - (existing?.size ?? 0);
    } catch (e) {
        calendar.gate.markDirty(gateKey(calendarId, uri));
        throw e;
    }
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

function uidOfResource(resource: ICAL.Component): string {
    return uidOf(resource.getAllSubcomponents('vevent')[0]);
}

// A copy of somebody else's event, which the owner may re-alarm and nothing more: the organizer stamp the
// server wrote says so, where the ORGANIZER address is the client's own to spell.
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

// What a write states beside its bytes: the preconditions it carries, and the stamps only the server may
// spell — the author of a resource nobody wrote before, and the address an imported file was filed under.
export type PutResourceOptions = {
    ifMatch: string | null;
    ifNoneMatch: string | null;
    actor?: string | null;
    importedOrganizer?: string | null;
    // An import files one UID once per Home, where a device syncs one calendar and owns only that one.
    uidUniqueInHome?: boolean;
};

// Preconditions, the UID rules, re-stamping and the linked-copy restriction are all decided here, inside
// the gate, against the state the write overwrites.
export async function putResource(
    calendar: Calendar,
    calendarId: string,
    uri: string,
    body: string,
    pre: PutResourceOptions,
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

    return calendar.gate.run(async (): Promise<PutResourceResult> => {
        // Sanitizing an id is not knowing it exists, and a write would otherwise mkdir a calendar nobody owns.
        if (!calendar.calendarRow(calendarId)) return { ok: false, error: 'no-collection' };

        // Two racing If-Match PUTs serialize through the gate, so the loser sees the winner's new etag here.
        const existing = calendar.db
            .select()
            .from(schema.resources)
            .where(and(eq(schema.resources.calendarId, calendarId), eq(schema.resources.uriKey, uriKeyOf(uri))))
            .get();
        const currentEtag = existing ? `"${existing.etag}"` : null;
        if (pre.ifNoneMatch !== null && matchesIfNoneMatch(pre.ifNoneMatch, currentEtag)) {
            return { ok: false, error: 'precondition' };
        }
        if (pre.ifMatch !== null && !matchesIfMatch(pre.ifMatch, currentEtag)) {
            return { ok: false, error: 'precondition' };
        }

        // A UID another resource owns is a conflict the client can act on, not a raw 500 on the UNIQUE index.
        // Decided here rather than before the gate, or two writers of one UID both read "nobody holds it".
        const holder = calendar.db
            .select({ id: schema.resources.id, uri: schema.resources.uri })
            .from(schema.resources)
            .where(
                pre.uidUniqueInHome
                    ? eq(schema.resources.uid, uid)
                    : and(eq(schema.resources.calendarId, calendarId), eq(schema.resources.uid, uid)),
            )
            .get();
        if (holder && holder.id !== existing?.id) return { ok: false, error: 'uid-conflict', conflictUri: holder.uri };
        if (existing && uid !== existing.uid) return { ok: false, error: 'uid-conflict' };

        // A case-variant PUT rewrites the existing file in place: writing under the caller's spelling would
        // strand the old file on a case-sensitive fs and let the next reconcile revert the accepted write.
        const storedUri = existing?.uri ?? uri;
        const storedBytes = existing
            ? await readResourceFile(calendar.storage, resourcePath(calendarId, storedUri))
            : null;
        const stored = storedBytes ? parseResource(new TextDecoder().decode(storedBytes)) : null;

        let resource: ICAL.Component;
        if (stored && isLinkedCopy(stored)) {
            adoptAlarms(stored, incoming);
            resource = stored;
        } else {
            // Nothing the body says about an Eigen line is trusted: the stamps come back from the stored
            // resource, and only a resource nobody wrote before takes the caller's own stamps.
            restampResource(incoming, stored, {
                createByUserId: stored ? undefined : (pre.actor ?? undefined),
                importedOrganizer: stored ? undefined : (pre.importedOrganizer ?? undefined),
            });
            resource = incoming;
        }

        // Prepared once here: the write below lands exactly the rows, bytes and hash these refusals judged.
        const prepared = prepareResource(calendarId, resource, existing?.id ?? null);
        // One resource is one series a client just wrote: a VEVENT of it Eigen cannot read makes the whole
        // payload malformed, where a previewed or imported file drops that one member and keeps going.
        if (prepared.skipped || prepared.duplicateMaster) {
            return { ok: false, error: 'invalid', reason: 'object', message: 'invalid iCalendar data' };
        }
        // The interval invariant the REST write holds, so both surfaces answer alike. A zero-length event
        // is legal (RFC 5545 §3.6.1) and common; one that ends before it starts is nobody's real event.
        if (prepared.rows.some((row) => row.endTime < row.startTime)) {
            return { ok: false, error: 'invalid', reason: 'data', message: 'event ends before it starts' };
        }

        // A client whose bytes are not what got stored has nothing to attach a validator to (RFC 4791 § 5.3.4).
        const validator = prepared.text === body ? prepared.etag : null;

        // Re-PUTting what is already stored changes nothing: writing it would bump the ctag and send every
        // other client back for a resource that never moved. Judged against the bytes, never the row: a
        // stale row would answer a PUT that does change the file with a no-op nobody ever learns about.
        if (storedBytes && prepared.etag === computeResourceEtag(storedBytes)) {
            return { ok: true, etag: validator, created: false };
        }

        // The stamps and the stored alarms decide the bytes, so both refusals are raised below the accepted
        // body — and each is a client error the protocol has an element for, not a 500.
        try {
            await writePrepared(calendar, calendarId, storedUri, prepared, existing ?? null);
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

export async function deleteResource(
    calendar: Calendar,
    calendarId: string,
    uri: string,
    pre: { ifMatch: string | null },
): Promise<DeleteResourceResult> {
    return calendar.gate.run(async (): Promise<DeleteResourceResult> => {
        const row = calendar.db
            .select()
            .from(schema.resources)
            .where(and(eq(schema.resources.calendarId, calendarId), eq(schema.resources.uriKey, uriKeyOf(uri))))
            .get();
        if (!row) return { ok: false, error: 'not-found' };
        if (pre.ifMatch !== null && !matchesIfMatch(pre.ifMatch, `"${row.etag}"`)) {
            return { ok: false, error: 'precondition' };
        }
        await calendar.purgeResource(row);
        return { ok: true };
    });
}
