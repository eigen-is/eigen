import { randomUUID } from 'node:crypto';
import { EIGEN_ACCENT_COLORS_SHUFFLED } from '@workspace/lib/constants/colors';
import { eq, inArray } from 'drizzle-orm';
import type ICAL from 'ical.js';
import {
    computeResourceEtag,
    dedupeByUid,
    diffFileStats,
    nextSyncGen,
    PATHS,
    type ResourceFile,
    readResourceFile,
    writeResourceFile,
} from '../core';
import { remintEventIds, serializeResource } from '../ical';
import type { Calendar } from './calendar';
import { projectRows } from './calendar-store';
import {
    calendarDir,
    clearPendingWrite,
    type EventRowInput,
    indexResource,
    resourcePath,
    sanitizeCalendarId,
    statCalendarDir,
} from './resource-store';
import * as schema from './schema';

// Files are the truth: this pass runs before anything is served and re-reads only what drifted.

// `.<calendarId>.deleting-<uuid>`: the id parses from the left of a fixed-width tail, so a dot inside a calendar id is fine.
const DELETING_DIR = /^\.(.+)\.deleting-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const UUID_NAME = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type IndexIncumbent = Pick<typeof schema.resources.$inferSelect, 'id' | 'uri' | 'uriKey' | 'uid' | 'etag'>;

// `restored` means the bytes still hash to the stored etag (only the stat moved), `rewritten` the bytes the copy rule reminted.
type Candidate = {
    calendarId: string;
    file: ResourceFile;
    id: string;
    uid: string;
    etag: string;
    rows: EventRowInput[];
    hasUnindexedRecurrence: boolean;
    restored: boolean;
    // The parsed file, kept until the copy rule has judged the candidate; a restore never parses one.
    resource: ICAL.Component | null;
    rewritten?: string;
};

// Which resource each `X-EIGEN-EVENT-ID` belongs to: two files a user copied by hand can both be new, with neither indexed yet.
type IdOwners = Map<string, string>;

// An id is free again only because its delete committed, so what is staged under a free id is deleted data.
export async function stagedDeletesOf(calendar: Calendar, id: string): Promise<string[]> {
    const entries = await calendar.storage.readdir(PATHS.CALENDAR.CALENDARS, { withFileTypes: true });
    return entries
        .filter((entry) => entry.isDirectory() && DELETING_DIR.exec(entry.name)?.[1] === id)
        .map((entry) => `${PATHS.CALENDAR.CALENDARS}/${entry.name}`);
}

async function isEmptyDir(calendar: Calendar, dir: string): Promise<boolean> {
    return (await calendar.storage.readdir(dir)).length === 0;
}

// Runs before anything can create a calendar directory, so an absent one means absent; one entry's failure only logs, since throwing takes the whole Home down.
async function sweepDeleting(calendar: Calendar): Promise<void> {
    for (const entry of await calendar.storage.readdir(PATHS.CALENDAR.CALENDARS, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const match = DELETING_DIR.exec(entry.name);
        if (!match) continue;
        const id = match[1];
        const staged = `${PATHS.CALENDAR.CALENDARS}/${entry.name}`;
        const live = calendarDir(id);
        try {
            // Staged files under a live row are a delete nobody acknowledged; an empty directory is no evidence of a delete that committed.
            if (calendar.calendarRow(id) && !(await isEmptyDir(calendar, staged))) {
                if ((await calendar.storage.dirExists(live)) && !(await isEmptyDir(calendar, live))) {
                    console.warn(`calendar: keeping ${entry.name} — calendar ${id} holds files of its own`);
                    continue;
                }
                await calendar.storage.removeDir(live);
                await calendar.storage.moveDurable(staged, live);
                console.warn(`calendar: rolled back the interrupted delete of calendar ${id}`);
                continue;
            }
            await calendar.storage.removeDir(staged);
        } catch (e) {
            console.error(`calendar: could not sweep ${entry.name}:`, e);
        }
    }
}

// A directory with no row is a calendar whose metadata the index lost; its generation rotates, so stale sync tokens are refused.
function recoverCalendarRows(calendar: Calendar, orphans: string[]): void {
    let hasDefault = !!calendar.db
        .select({ id: schema.calendars.id })
        .from(schema.calendars)
        .where(eq(schema.calendars.isDefault, true))
        .get();
    let recovered = 0;
    let unnamed = 0;
    for (const id of orphans) {
        // A calendar id is unique case-insensitively, so a second row over the same directory would reconcile its files twice.
        if (calendar.calendarIdTaken(id)) {
            console.warn(`calendar: leaving directory ${id} alone — a calendar already holds that id`);
            continue;
        }
        const isUuid = UUID_NAME.test(id);
        if (isUuid) unnamed++;
        const name = isUuid ? `Recovered calendar${unnamed > 1 ? ` ${unnamed}` : ''}` : id;
        try {
            calendar.db
                .insert(schema.calendars)
                .values({
                    id,
                    name,
                    color: EIGEN_ACCENT_COLORS_SHUFFLED[recovered++ % EIGEN_ACCENT_COLORS_SHUFFLED.length].value,
                    isDefault: !hasDefault,
                    ctag: 0,
                    syncGen: nextSyncGen(undefined, Date.now()),
                    shares: null,
                })
                .run();
            hasDefault = true;
            console.warn(`calendar: recovered calendar ${id} from its directory`);
        } catch (e) {
            console.error(`calendar: could not recover calendar ${id} from its directory:`, e);
        }
    }
}

// A row id another resource already holds means this file is a copy of one, so it gets fresh ids.
function applyCopyRule(calendar: Calendar, candidate: Candidate, owners: IdOwners): void {
    const resource = candidate.resource;
    if (!resource) return;
    const ids = candidate.rows.map((row) => row.id);
    const indexed = calendar.db
        .select({ id: schema.events.id, resourceId: schema.events.resourceId })
        .from(schema.events)
        .where(inArray(schema.events.id, ids))
        .all();
    const stolen =
        indexed.some((row) => row.resourceId !== candidate.id) ||
        ids.some((id) => (owners.get(id) ?? candidate.id) !== candidate.id);

    if (stolen) {
        console.warn(
            `calendar: ${candidate.calendarId}/${candidate.file.uri} repeats another resource's event ids — reminting`,
        );
        remintEventIds(resource);
        const projection = projectRows(candidate.calendarId, candidate.id, resource);
        candidate.rows = projection.rows;
        candidate.rewritten = serializeResource(resource);
    }
    for (const row of candidate.rows) owners.set(row.id, candidate.id);
}

// A file whose bytes still hash to the stored etag is a restore: nothing is parsed, because only its timestamp moved.
async function buildCandidate(
    calendar: Calendar,
    calendarId: string,
    file: ResourceFile,
    existing: IndexIncumbent | undefined,
): Promise<Candidate | null> {
    const bytes = await readResourceFile(calendar.storage, resourcePath(calendarId, file.uri));
    if (!bytes) return null;
    const etag = computeResourceEtag(bytes);
    const id = existing?.id ?? randomUUID();
    if (existing && etag === existing.etag) {
        return {
            calendarId,
            file,
            id,
            uid: existing.uid,
            etag,
            rows: [],
            hasUnindexedRecurrence: false,
            restored: true,
            resource: null,
        };
    }

    const resource = calendar.parseResourceFile(bytes);
    const projection = projectRows(calendarId, id, resource);
    const uid = projection.rows[0]?.uid ?? '';
    if (!uid) {
        console.warn(`calendar: skipping ${calendarId}/${file.uri} — it names no VEVENT with a UID`);
        return null;
    }
    if (projection.duplicateMaster) {
        console.warn(`calendar: ${calendarId}/${file.uri} names ${uid} twice as a master — the first one leads`);
    }
    return {
        calendarId,
        file,
        id,
        uid,
        etag,
        rows: projection.rows,
        hasUnindexedRecurrence: projection.hasUnindexedRecurrence,
        restored: false,
        resource,
    };
}

async function buildCandidates(
    calendar: Calendar,
    calendarId: string,
    entries: { file: ResourceFile; existing?: IndexIncumbent }[],
): Promise<Candidate[]> {
    const candidates: Candidate[] = [];
    for (const { file, existing } of entries) {
        try {
            const candidate = await buildCandidate(calendar, calendarId, file, existing);
            if (candidate) candidates.push(candidate);
        } catch (e) {
            // An unindexable file stays on disk, is never deleted, and still counts toward the bytes.
            console.warn(`calendar: skipping unreadable resource ${calendarId}/${file.uri}: ${e}`);
        }
    }
    return candidates;
}

// The reminted bytes go back to disk before their rows are indexed, so file and index agree; the delta is against what the stat pass counted.
async function rewriteCopies(calendar: Calendar, candidates: Candidate[]): Promise<number> {
    let delta = 0;
    for (const candidate of candidates) {
        if (!candidate.rewritten) continue;
        const bytes = new TextEncoder().encode(candidate.rewritten);
        const stat = await writeResourceFile(
            calendar.storage,
            resourcePath(candidate.calendarId, candidate.file.uri),
            bytes,
        );
        delta += stat.size - candidate.file.size;
        candidate.file = { ...candidate.file, ...stat };
        candidate.etag = computeResourceEtag(bytes);
    }
    return delta;
}

function writeIndexed(calendar: Calendar, calendarId: string, candidates: Candidate[]): void {
    const changed = candidates.filter((c) => !c.restored);

    calendar.db.transaction((tx) => {
        // A restore drifts every mtime, so re-stamping a file that still hashes the same would send every client back for the whole collection.
        for (const c of candidates) {
            if (!c.restored) continue;
            tx.update(schema.resources)
                .set({ mtime: c.file.mtime, size: c.file.size })
                .where(eq(schema.resources.id, c.id))
                .run();
        }

        if (changed.length > 0) {
            const ctag = calendar.bumpCtag(tx, calendarId);
            for (const c of changed) {
                indexResource(
                    tx,
                    {
                        id: c.id,
                        calendarId,
                        uri: c.file.uri,
                        uid: c.uid,
                        etag: c.etag,
                        mtime: c.file.mtime,
                        size: c.file.size,
                        resourceCtag: ctag,
                        hasUnindexedRecurrence: c.hasUnindexedRecurrence,
                    },
                    c.rows,
                );
            }
        }

        // This pass settled every prepared uri, so the recovery drain behind init owes their intents nothing.
        for (const c of candidates) clearPendingWrite(tx, calendarId, c.file.uri);
    });
}

// Vanished resources are dropped before the new are indexed, or a crashed move loses the ids it carried.
export async function reconcileIndex(calendar: Calendar): Promise<void> {
    return calendar.gate.run(async () => {
        await sweepDeleting(calendar);

        const dirs = (await calendar.storage.readdir(PATHS.CALENDAR.CALENDARS, { withFileTypes: true }))
            .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
            .map((entry) => entry.name)
            .sort();
        const known = new Set(
            calendar.db
                .select({ id: schema.calendars.id })
                .from(schema.calendars)
                .all()
                .map((r) => r.id),
        );
        const orphans = dirs.filter((dir) => !known.has(dir) && sanitizeCalendarId(dir) === dir);
        recoverCalendarRows(calendar, orphans);

        const calendarIds = calendar.db
            .select({ id: schema.calendars.id })
            .from(schema.calendars)
            .all()
            .map((r) => r.id);
        let bytes = 0;

        // Phase 1: one stat pass per calendar directory — no file is read, so a clean init parses nothing.
        const passes: {
            calendarId: string;
            entries: { file: ResourceFile; existing?: IndexIncumbent }[];
            vanished: IndexIncumbent[];
        }[] = [];
        for (const calendarId of calendarIds) {
            // A directory that cannot be read is excluded: counting it as "every file vanished" would tombstone a collection over a transient IO error.
            try {
                await calendar.storage.mkdir(calendarDir(calendarId));
                await calendar.storage.sweepAtomicTemps(calendarDir(calendarId));
                const scan = await statCalendarDir(calendar.storage, calendarId);
                for (const file of scan.files.values()) bytes += file.size;

                const indexed = calendar.db
                    .select({
                        id: schema.resources.id,
                        uri: schema.resources.uri,
                        uriKey: schema.resources.uriKey,
                        uid: schema.resources.uid,
                        etag: schema.resources.etag,
                        mtime: schema.resources.mtime,
                        size: schema.resources.size,
                    })
                    .from(schema.resources)
                    .where(eq(schema.resources.calendarId, calendarId))
                    .all();
                const diff = diffFileStats(scan, new Map(indexed.map((r) => [r.uriKey, r])));
                // Sorted, so a uid collision resolves the same way on every pass.
                const entries = [
                    ...diff.added.map((file) => ({ file, existing: undefined })),
                    ...diff.changed.map(({ file, row }) => ({ file, existing: row })),
                ].sort((a, b) => (a.file.uri < b.file.uri ? -1 : a.file.uri > b.file.uri ? 1 : 0));
                passes.push({ calendarId, entries, vanished: diff.vanished });
            } catch (e) {
                console.error(`calendar: could not scan calendar ${calendarId}:`, e);
            }
        }

        // A stale index beats an unopenable Home, so a failure here ends the pass and leaves the index as it was.
        try {
            if (passes.some((pass) => pass.vanished.length > 0)) {
                calendar.db.transaction((tx) => {
                    for (const pass of passes) {
                        if (!pass.vanished.length) continue;
                        const ctag = calendar.bumpCtag(tx, pass.calendarId);
                        for (const row of pass.vanished) {
                            tx.delete(schema.resources).where(eq(schema.resources.id, row.id)).run();
                            calendar.tombstone(tx, pass.calendarId, row.uri, row.uriKey, ctag);
                        }
                    }
                });
            }
        } catch (e) {
            console.error('calendar: could not drop the vanished resources — the index stays as it was:', e);
            calendar.eventsBytes = bytes;
            return;
        }

        // One calendar throwing leaves that calendar stale rather than failing Home.init, which would make the whole Home unopenable.
        const owners: IdOwners = new Map();
        for (const pass of passes) {
            if (!pass.entries.length) continue;
            try {
                const candidates = await buildCandidates(calendar, pass.calendarId, pass.entries);
                // Seeded with every row that remains after the vanished deletes, so a new same-UID file loses to the incumbent.
                const uidOwner = new Map(
                    calendar.db
                        .select({ uid: schema.resources.uid, id: schema.resources.id })
                        .from(schema.resources)
                        .where(eq(schema.resources.calendarId, pass.calendarId))
                        .all()
                        .map((r) => [`${pass.calendarId}|${r.uid}`, r.id] as const),
                );
                // A loser is skipped and logged, never deleted: two files with one UID is what copying one by hand leaves.
                const prepared = dedupeByUid(candidates, uidOwner, (c) => ({
                    scope: `${pass.calendarId}|${c.uid}`,
                    id: c.id,
                    uri: `${pass.calendarId}/${c.file.uri}`,
                }));
                for (const candidate of prepared) applyCopyRule(calendar, candidate, owners);
                bytes += await rewriteCopies(calendar, prepared);
                writeIndexed(calendar, pass.calendarId, prepared);
            } catch (e) {
                console.error(`calendar: could not index calendar ${pass.calendarId}:`, e);
            }
        }

        calendar.eventsBytes = bytes;
    });
}
