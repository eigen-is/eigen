import { randomUUID } from 'node:crypto';
import { isInvitationFromOthers } from '@workspace/lib/calendar/calendar-utils';
import { and, eq, gt, inArray } from 'drizzle-orm';
import type ICAL from 'ical.js';
import {
    computeResourceEtag,
    type DeleteResourceResult,
    matchesIfMatch,
    matchesIfNoneMatch,
    type PutResourceResult,
    readResourceFile,
    uriKeyOf,
    writeResourceFile,
} from '../core';
import { parseResource, projectResource, restampResource, serializeResource } from '../ical';
import { recurrenceKeyOf, seriesTimezones, uidOf } from '../ical/ical-parse';
import type { Calendar } from './calendar';
import type { EventRowInput } from './resource-store';
import {
    EVENT_MAX_BYTES,
    gateKey,
    resourcePath,
    sanitizeCalendarId,
    sanitizeEventUri,
    statCalendarDir,
} from './resource-store';
import * as schema from './schema';

// The store seam over the Calendar facade: one file per UID, the index behind it. Every mutation runs inside
// the write gate against the state it overwrites; every read drains a torn pair first.
// See docs/CALENDAR.md § Storage.

// The index projection the DAV layer reads for a resource; the etag is the hash the handler quotes.
export type ResourceRow = {
    id: string;
    uri: string;
    uid: string;
    etag: string;
    hasUnindexedRecurrence: boolean;
};

const RESOURCE_ROW = {
    id: schema.resources.id,
    uri: schema.resources.uri,
    uid: schema.resources.uid,
    etag: schema.resources.etag,
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

// The resource rows a file projects to, ids taken from the `X-EIGEN-EVENT-ID` the file carries. An id a
// sibling VEVENT of the same file already claimed is minted fresh: one stored id belongs to one row.
export function projectRows(
    calendarId: string,
    resourceId: string,
    resource: ICAL.Component,
): { rows: EventRowInput[]; hasUnindexedRecurrence: boolean; skipped: number } {
    const projected = projectResource(resource);
    const now = new Date();
    const claimed = new Set<string>();
    const identified = projected.events.map((event) => {
        const id = event.eventId && !claimed.has(event.eventId) ? event.eventId : randomUUID();
        claimed.add(id);
        return { event, id };
    });

    // A master leads its own overrides, whatever order the file lists them in.
    const masterIdByUid = new Map<string, string>();
    for (const { event, id } of identified) {
        if (event.recurrenceDate === null) masterIdByUid.set(event.uid, id);
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

    return { rows, hasUnindexedRecurrence: projected.hasUnindexedRecurrence, skipped: projected.skipped };
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

// Hashing the bytes just read keeps body and validator one revision; a disagreeing row is marked, or a
// durably stale etag would 412 every conditional write forever.
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

// The one pair of file write + index commit. The caller holds the gate and owns the component; a throw
// anywhere after the rename leaves the key dirty for the next drain.
export async function writeResource(
    calendar: Calendar,
    calendarId: string,
    uri: string,
    resource: ICAL.Component,
    existing: { id: string; size: number } | null,
): Promise<{ etag: string; text: string }> {
    const id = existing?.id ?? randomUUID();
    const projection = projectRows(calendarId, id, resource);
    const text = serializeResource(resource);
    const bytes = new TextEncoder().encode(text);
    const etag = computeResourceEtag(bytes);

    try {
        // Only a replacement can land bytes a later stat diff cannot see; a new name is always visible.
        if (existing) calendar.recordPendingWrite(calendarId, uri);
        const { mtime, size } = await writeResourceFile(calendar.storage, resourcePath(calendarId, uri), bytes);
        calendar.commitResource({
            id,
            calendarId,
            uri,
            uid: uidOfResource(resource),
            etag,
            mtime,
            size,
            rows: projection.rows,
            hasUnindexedRecurrence: projection.hasUnindexedRecurrence,
        });
        calendar.eventsBytes += size - (existing?.size ?? 0);
    } catch (e) {
        calendar.gate.markDirty(gateKey(calendarId, uri));
        throw e;
    }
    return { etag, text };
}

export function uidOfResource(resource: ICAL.Component): string {
    const vevents = resource.getAllSubcomponents('vevent');
    return vevents.length ? uidOf(vevents[0]) : '';
}

// A stored resource organized by somebody else: the owner may change its reminders and nothing more, so a
// full-replace PUT keeps the stored component and takes only the body's VALARM set.
function isInvitationCopy(calendar: Calendar, stored: ICAL.Component): boolean {
    const master = projectResource(stored).events.find((e) => e.recurrenceDate === null);
    return !!master && isInvitationFromOthers(master, calendar.home.user.email);
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
        for (const alarm of match.getAllSubcomponents('valarm')) vevent.addSubcomponent(alarm);
    }
}

// Preconditions, the UID rules, re-stamping and the linked-copy restriction are all decided here, inside
// the gate, against the state the write overwrites.
export async function putResource(
    calendar: Calendar,
    calendarId: string,
    uri: string,
    body: string,
    pre: { ifMatch: string | null; ifNoneMatch: string | null; actor?: string | null },
): Promise<PutResourceResult> {
    if (sanitizeCalendarId(calendarId) !== calendarId) return { ok: false, error: 'invalid' };
    if (sanitizeEventUri(uri) !== uri) return { ok: false, error: 'invalid' };

    return calendar.gate.run(async (): Promise<PutResourceResult> => {
        // Sanitizing an id is not knowing it exists, and a write would otherwise mkdir a calendar nobody owns.
        if (!calendar.calendarRow(calendarId)) return { ok: false, error: 'invalid', message: 'Calendar not found' };

        // Bounded before any parse, so a hostile payload never reaches the component builder.
        if (Buffer.byteLength(body) > EVENT_MAX_BYTES) return { ok: false, error: 'too-large' };

        let incoming: ICAL.Component;
        try {
            incoming = parseResource(body);
        } catch {
            return { ok: false, error: 'invalid', message: 'invalid iCalendar data' };
        }

        const vevents = incoming.getAllSubcomponents('vevent');
        if (!vevents.length) return { ok: false, error: 'invalid', message: 'no VEVENT found' };
        // One resource is one series: a second UID's overrides would otherwise hang off this master.
        const uids = new Set(vevents.map(uidOf));
        if (uids.size > 1) return { ok: false, error: 'invalid', message: 'one UID per resource' };
        const uid = [...uids][0];
        if (!uid) return { ok: false, error: 'invalid', message: 'UID is required' };

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
        const holder = calendar.db
            .select({ id: schema.resources.id, uri: schema.resources.uri })
            .from(schema.resources)
            .where(and(eq(schema.resources.calendarId, calendarId), eq(schema.resources.uid, uid)))
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
        if (stored && isInvitationCopy(calendar, stored)) {
            adoptAlarms(stored, incoming);
            resource = stored;
        } else {
            // Nothing the body says about an Eigen line is trusted: the stamps come back from the stored
            // resource, and only a resource nobody wrote before takes the actor as its author.
            restampResource(incoming, stored, { createByUserId: stored ? undefined : (pre.actor ?? undefined) });
            resource = incoming;
        }

        const id = existing?.id ?? randomUUID();
        const projection = projectRows(calendarId, id, resource);
        // One resource is one series a client just wrote: a VEVENT of it Eigen cannot read makes the whole
        // payload malformed, where a previewed or imported file drops that one member and keeps going.
        if (projection.skipped) return { ok: false, error: 'invalid', message: 'invalid iCalendar data' };

        const text = serializeResource(resource);
        if (Buffer.byteLength(text) > EVENT_MAX_BYTES) return { ok: false, error: 'too-large' };

        const { etag } = await writeResource(calendar, calendarId, storedUri, resource, existing ?? null);

        // A client whose bytes are not what got stored has nothing to attach a validator to (RFC 4791 § 5.3.4).
        return { ok: true, etag: text === body ? etag : null, created: !existing };
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

// The whole-directory scan one reconcile pass makes of a calendar.
export function scanCalendar(calendar: Calendar, calendarId: string) {
    return statCalendarDir(calendar.storage, calendarId);
}
