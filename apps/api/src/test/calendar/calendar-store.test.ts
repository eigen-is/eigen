import { beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import {
    cpSync,
    mkdirSync,
    readdirSync,
    readFileSync,
    renameSync,
    rmSync,
    statSync,
    utimesSync,
    writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import type { Calendar } from '../../lib/calendar/calendar';
import { LocalFilesystem, PATHS } from '../../lib/core';
import { calendarsDirOf, makeCalendar } from '../calendar-test-helpers';
import type { TestHome } from '../home-test-helpers';
import { vcal } from '../ics-test-helpers';

// The file store behind every calendar write: what lands on disk, what the index says about it, and what
// each of them looks like after a crash. See docs/CALENDAR.md § Storage.

// A filesystem that dies exactly where a process can: after the rename that made a write durable, and
// after the unlink that made a delete durable — both before the index commit that settles the pair.
class DyingFilesystem extends LocalFilesystem {
    dieAfterWrite = false;
    dieAfterUnlink = false;

    override async writeAtomic(filePath: string, data: Buffer | Uint8Array | string): Promise<void> {
        await super.writeAtomic(filePath, data);
        if (this.dieAfterWrite) throw new Error('the process died after the rename');
    }

    override async unlinkDurable(filePath: string): Promise<void> {
        await super.unlinkDurable(filePath);
        if (this.dieAfterUnlink) throw new Error('the process died after the unlink');
    }
}

const event = (uid: string, summary: string, extra: string[] = []): string[] => [
    'BEGIN:VEVENT',
    `UID:${uid}`,
    'DTSTART:20260401T100000Z',
    'DTEND:20260401T110000Z',
    `SUMMARY:${summary}`,
    ...extra,
    'END:VEVENT',
];

const put = (calendar: Calendar, calendarId: string, uri: string, body: string) =>
    calendar.putResource(calendarId, uri, body, { ifMatch: null, ifNoneMatch: null });

const fileOf = (harness: TestHome<Calendar>, calendarId: string, uri: string) =>
    join(calendarsDirOf(harness.dir), calendarId, uri);

async function defaultCalendarId(harness: TestHome<Calendar>): Promise<string> {
    return (await harness.instance.getCalendars())[0].id;
}

describe('calendar file store', () => {
    beforeAll(() => {
        rmSync(join(import.meta.dir, '../../../../../data-test'), { recursive: true, force: true });
    });

    test('a stored resource is the file on disk, and the index projects it', async () => {
        const harness = await makeCalendar();
        const calendarId = await defaultCalendarId(harness);

        const result = await put(harness.instance, calendarId, 'first.ics', vcal(event('store-1@eigen', 'Kickoff')));
        expect(result.ok).toBe(true);

        const stored = readFileSync(fileOf(harness, calendarId, 'first.ics'), 'utf8');
        expect(stored).toContain('SUMMARY:Kickoff');
        // The row id rides in the file, so the index can be thrown away and rebuilt from it.
        expect(stored).toContain('X-EIGEN-EVENT-ID:');

        const served = await harness.instance.getResource(calendarId, 'first.ics');
        expect(new TextDecoder().decode(served!.bytes)).toBe(stored);

        const rows = await harness.instance.getRawEvents(calendarId);
        expect(rows.map((r) => r.title)).toEqual(['Kickoff']);
        expect(rows[0].uri).toBe('first.ics');
        expect(rows[0].etag).toBe(served!.etag);
    });

    test('a commit that fails after the rename leaves the key dirty, and the next read settles it', async () => {
        let storage!: DyingFilesystem;
        const harness = await makeCalendar((homeDir) => {
            storage = new DyingFilesystem(`${homeDir}/${PATHS.CALENDAR.ROOT}`);
            return storage;
        });
        const calendarId = await defaultCalendarId(harness);
        await put(harness.instance, calendarId, 'torn.ics', vcal(event('torn@eigen', 'Before')));

        storage.dieAfterWrite = true;
        await expect(put(harness.instance, calendarId, 'torn.ics', vcal(event('torn@eigen', 'After')))).rejects.toThrow(
            'the process died after the rename',
        );
        storage.dieAfterWrite = false;

        // The file is the truth, so the very next read re-indexes it before answering.
        const rows = await harness.instance.getRawEvents(calendarId);
        expect(rows.map((r) => r.title)).toEqual(['After']);
        const served = await harness.instance.getResource(calendarId, 'torn.ics');
        expect(new TextDecoder().decode(served!.bytes)).toContain('SUMMARY:After');
        expect(rows[0].etag).toBe(served!.etag);
    });

    test('a replacement whose stat never moved is recovered by the journal alone', async () => {
        let storage!: DyingFilesystem;
        const harness = await makeCalendar((homeDir) => {
            storage = new DyingFilesystem(`${homeDir}/${PATHS.CALENDAR.ROOT}`);
            return storage;
        });
        const calendarId = await defaultCalendarId(harness);
        await put(harness.instance, calendarId, 'same-stat.ics', vcal(event('same-stat@eigen', 'AAAAA')));
        const path = fileOf(harness, calendarId, 'same-stat.ics');
        const before = statSync(path);

        storage.dieAfterWrite = true;
        await expect(
            // Same byte length, so only the recorded write intent can tell the index it is behind.
            put(harness.instance, calendarId, 'same-stat.ics', vcal(event('same-stat@eigen', 'BBBBB'))),
        ).rejects.toThrow();
        const after = statSync(path);
        expect(after.size).toBe(before.size);
        // The index rounds the mtime to whole milliseconds, so putting the file back on exactly that
        // number is what makes the stat diff blind to the replacement.
        utimesSync(path, before.atimeMs / 1000, Math.round(before.mtimeMs) / 1000);

        const restarted = await harness.reopen();
        try {
            const rows = await restarted.instance.getRawEvents(calendarId);
            expect(rows.map((r) => r.title)).toEqual(['BBBBB']);
        } finally {
            await restarted.close();
        }
    });

    test('a delete that died after the unlink is tombstoned at the next open', async () => {
        let storage!: DyingFilesystem;
        const harness = await makeCalendar((homeDir) => {
            storage = new DyingFilesystem(`${homeDir}/${PATHS.CALENDAR.ROOT}`);
            return storage;
        });
        const calendarId = await defaultCalendarId(harness);
        await put(harness.instance, calendarId, 'doomed.ics', vcal(event('doomed@eigen', 'Doomed')));
        const ctag = (await harness.instance.getCollection(calendarId))!.ctag;

        storage.dieAfterUnlink = true;
        await expect(harness.instance.deleteResource(calendarId, 'doomed.ics', { ifMatch: null })).rejects.toThrow(
            'the process died after the unlink',
        );

        const restarted = await harness.reopen();
        try {
            expect(await restarted.instance.getRawEvents(calendarId)).toHaveLength(0);
            const deleted = await restarted.instance.getDeletedResourcesSince(calendarId, ctag);
            expect(deleted.map((d) => d.uri)).toEqual(['doomed.ics']);
        } finally {
            await restarted.close();
        }
    });

    test('a calendar delete that crashed before its commit is rolled back', async () => {
        const harness = await makeCalendar();
        const cal = await harness.instance.createCalendar({ name: 'Rollback', color: '#2563eb' });
        await put(harness.instance, cal.id, 'kept.ics', vcal(event('kept@eigen', 'Kept')));

        // The delete staged the directory and died before the row delete could commit.
        renameSync(
            join(calendarsDirOf(harness.dir), cal.id),
            join(calendarsDirOf(harness.dir), `.${cal.id}.deleting-${randomUUID()}`),
        );

        const restarted = await harness.reopen();
        try {
            expect((await restarted.instance.getCalendarById(cal.id))?.name).toBe('Rollback');
            expect((await restarted.instance.getRawEvents(cal.id)).map((r) => r.title)).toEqual(['Kept']);
        } finally {
            await restarted.close();
        }
    });

    test('a calendar delete whose row is already gone is swept', async () => {
        const harness = await makeCalendar();
        // A delete whose row committed and whose directory removal is what died.
        const staged = join(calendarsDirOf(harness.dir), `.${randomUUID()}.deleting-${randomUUID()}`);
        mkdirSync(staged, { recursive: true });
        writeFileSync(join(staged, 'gone.ics'), vcal(event('gone@eigen', 'Gone')));

        const restarted = await harness.reopen();
        try {
            expect(readdirSync(calendarsDirOf(harness.dir)).some((name) => name.includes('.deleting-'))).toBe(false);
            expect(await restarted.instance.getCalendars()).toHaveLength(1);
        } finally {
            await restarted.close();
        }
    });

    test('a file already moved to its target calendar keeps its ids, and the source is tombstoned', async () => {
        const harness = await makeCalendar();
        // Created first, so the index pass reaches the target before the source it came from.
        const target = await harness.instance.createCalendar({ name: 'B-target', color: '#2563eb' });
        const source = await harness.instance.createCalendar({ name: 'A-source', color: '#16a34a' });
        await put(harness.instance, source.id, 'moved.ics', vcal(event('moved@eigen', 'Moved')));
        const storedId = (await harness.instance.getRawEvents(source.id))[0].id;
        const sourceCtag = (await harness.instance.getCollection(source.id))!.ctag;

        // A move that renamed the file and died before its transaction: no journal row, by design.
        renameSync(fileOf(harness, source.id, 'moved.ics'), fileOf(harness, target.id, 'moved.ics'));

        const restarted = await harness.reopen();
        try {
            expect(await restarted.instance.getRawEvents(source.id)).toHaveLength(0);
            const rows = await restarted.instance.getRawEvents(target.id);
            expect(rows.map((r) => r.id)).toEqual([storedId]);
            const deleted = await restarted.instance.getDeletedResourcesSince(source.id, sourceCtag);
            expect(deleted.map((d) => d.uri)).toEqual(['moved.ics']);
        } finally {
            await restarted.close();
        }
    });

    test('an unchanged open is stat-only, and a restore moves nothing but the stats', async () => {
        const harness = await makeCalendar();
        const calendarId = await defaultCalendarId(harness);
        await put(harness.instance, calendarId, 'quiet.ics', vcal(event('quiet@eigen', 'Quiet')));
        const collection = (await harness.instance.getCollection(calendarId))!;

        const reopened = await harness.reopen();
        expect(reopened.instance.resourceParseCount).toBe(0);
        expect((await reopened.instance.getCollection(calendarId))!.ctag).toBe(collection.ctag);

        // A restore drifts every timestamp while the bytes stay what they were.
        const path = fileOf(harness, calendarId, 'quiet.ics');
        const future = new Date(Date.now() + 120_000);
        utimesSync(path, future, future);

        const restored = await reopened.reopen();
        try {
            // Reading the file to hash it is not parsing it: nothing about the resource changed.
            expect(restored.instance.resourceParseCount).toBe(0);
            const after = (await restored.instance.getCollection(calendarId))!;
            expect(after.ctag).toBe(collection.ctag);
            expect(after.syncGen).toBe(collection.syncGen);
            expect(await restored.instance.getDeletedResourcesSince(calendarId, 0)).toHaveLength(0);
        } finally {
            await restored.close();
        }
    });

    test('a lost calendar.db comes back from the files, ids and all, on a rotated generation', async () => {
        const harness = await makeCalendar();
        const named = await harness.instance.createCalendar({ name: 'Work', color: '#2563eb', id: 'work' });
        const uuidNamed = await harness.instance.createCalendar({ name: 'Private', color: '#16a34a' });
        await put(
            harness.instance,
            named.id,
            'series.ics',
            vcal([
                'BEGIN:VEVENT',
                'UID:rebuild@eigen',
                'DTSTART:20260401T100000Z',
                'DTEND:20260401T110000Z',
                'RRULE:FREQ=WEEKLY;COUNT=5',
                'EXDATE:20260415T100000Z',
                'SUMMARY:Series',
                'END:VEVENT',
                'BEGIN:VEVENT',
                'UID:rebuild@eigen',
                'RECURRENCE-ID:20260408T100000Z',
                'DTSTART:20260408T140000Z',
                'DTEND:20260408T150000Z',
                'SUMMARY:Series (moved)',
                'END:VEVENT',
            ]),
        );
        await put(harness.instance, uuidNamed.id, 'solo.ics', vcal(event('solo@eigen', 'Solo')));
        const before = await harness.instance.getRawEvents(named.id);
        const syncGen = (await harness.instance.getCollection(named.id))!.syncGen;

        for (const suffix of ['', '-wal', '-shm']) {
            rmSync(join(harness.dir, `${PATHS.CALENDAR.DB}${suffix}`), { force: true });
        }

        const rebuilt = await harness.reopen();
        try {
            // Every row — master, override and exclusion — is back under the id its file carries.
            const rows = await rebuilt.instance.getRawEvents(named.id);
            expect(rows.map((r) => r.id).sort()).toEqual(before.map((r) => r.id).sort());
            expect(rows.filter((r) => r.status === 'cancelled')).toHaveLength(1);
            expect(rows.filter((r) => r.recurrenceDate === '2026-04-08')).toHaveLength(1);

            // The directory name is the id; it is the display name too unless it says nothing, and the
            // ones that say nothing are numbered from the second.
            expect((await rebuilt.instance.getCalendarById(named.id))!.name).toBe('work');
            const recovered = await rebuilt.instance.getCalendars();
            expect(recovered.map((c) => c.name).sort()).toEqual(['Recovered calendar', 'Recovered calendar 2', 'work']);
            expect(recovered.filter((c) => c.isDefault)).toHaveLength(1);
            // A rotated generation is what refuses every sync token minted against the lost index.
            expect((await rebuilt.instance.getCollection(named.id))!.syncGen).not.toBe(syncGen);
        } finally {
            await rebuilt.close();
        }
    });

    test('a file copied by hand loses to the original, and the Home still opens', async () => {
        const harness = await makeCalendar();
        const calendarId = await defaultCalendarId(harness);
        await put(harness.instance, calendarId, 'a.ics', vcal(event('twin@eigen', 'Twin')));
        cpSync(fileOf(harness, calendarId, 'a.ics'), fileOf(harness, calendarId, 'b.ics'));

        const restarted = await harness.reopen();
        try {
            const resources = await restarted.instance.listResources(calendarId);
            expect(resources.map((r) => r.uri)).toEqual(['a.ics']);
            expect(await restarted.instance.getRawEvents(calendarId)).toHaveLength(1);
        } finally {
            await restarted.close();
        }
    });

    test('two new files carrying one event id are pulled apart, and the loser is rewritten', async () => {
        const harness = await makeCalendar();
        const calendarId = await defaultCalendarId(harness);
        const sharedId = randomUUID();
        for (const [uri, uid] of [
            ['one.ics', 'copy-one@eigen'],
            ['two.ics', 'copy-two@eigen'],
        ]) {
            writeFileSync(
                fileOf(harness, calendarId, uri),
                vcal(event(uid, 'Hand written', [`X-EIGEN-EVENT-ID:${sharedId}`])),
            );
        }

        const restarted = await harness.reopen();
        try {
            const rows = await restarted.instance.getRawEvents(calendarId);
            expect(rows).toHaveLength(2);
            expect(new Set(rows.map((r) => r.id)).size).toBe(2);
            // The reminted file is rewritten, so its bytes and its rows carry the same ids.
            const rewritten = readFileSync(fileOf(harness, calendarId, 'two.ics'), 'utf8');
            expect(rewritten).not.toContain(sharedId);
            expect(rewritten).toContain(rows.find((r) => r.uid === 'copy-two@eigen')!.id);
        } finally {
            await restarted.close();
        }
    });

    test('a name a file system cannot hold is refused, never rewritten', async () => {
        const harness = await makeCalendar();
        const calendarId = await defaultCalendarId(harness);
        const body = vcal(event('unsafe@eigen', 'Unsafe'));

        for (const uri of ['../escape.ics', 'x', 'plain.txt', `${'x'.repeat(300)}.ics`, 'calendar.db', '.hidden.ics']) {
            const result = await put(harness.instance, calendarId, uri, body);
            expect(result).toEqual({ ok: false, error: 'invalid' });
        }
        expect(await harness.instance.listResources(calendarId)).toHaveLength(0);
    });

    test('two calendars cannot share one directory, whatever the case', async () => {
        const harness = await makeCalendar();
        await harness.instance.createCalendar({ name: 'Work', color: '#2563eb', id: 'Work' });
        await expect(harness.instance.createCalendar({ name: 'work', color: '#16a34a', id: 'work' })).rejects.toThrow(
            'Calendar already exists',
        );
        await expect(
            harness.instance.createCalendar({ name: 'bad', color: '#16a34a', id: '../escape' }),
        ).rejects.toThrow('Invalid calendar name');
    });
});
