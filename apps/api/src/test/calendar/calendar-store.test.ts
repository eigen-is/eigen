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
import { eq, sql } from 'drizzle-orm';
import { Calendar } from '../../lib/calendar/calendar';
import { calendarStorage, EVENT_MAX_BYTES } from '../../lib/calendar/resource-store';
import * as schema from '../../lib/calendar/schema';
import { LocalFilesystem, PATHS } from '../../lib/core';
import { CALENDAR_TEST_ROOT, calendarsDirOf, DyingFilesystem, makeCalendar } from '../calendar-test-helpers';
import { makeTestHome, type TestHome } from '../home-test-helpers';
import { vcal } from '../ics-test-helpers';

// The file store behind every calendar write: what lands on disk, what the index says about it, and what
// each of them looks like after a crash. See docs/CALENDAR.md § Storage.

// A filesystem whose next directory move fails, the way a roll-back can fail once and still be owed.
class MoveFailingFilesystem extends LocalFilesystem {
    static failNextMove = false;

    override async moveDurable(from: string, to: string): Promise<void> {
        if (MoveFailingFilesystem.failNextMove) {
            MoveFailingFilesystem.failNextMove = false;
            throw new Error('the directory move failed');
        }
        await super.moveDurable(from, to);
    }
}

// A filesystem whose staging removal fails, which is what leaves a committed delete its directory.
class RemoveFailingFilesystem extends LocalFilesystem {
    static failRemoveDir = false;

    override async removeDir(dirPath: string): Promise<void> {
        if (RemoveFailingFilesystem.failRemoveDir) throw new Error('the directory removal failed');
        await super.removeDir(dirPath);
    }
}

// A home whose index transaction fails where a real one can: the Home-wide phase of the reconcile.
class TombstoneFailingCalendar extends Calendar {
    static failing = false;

    override tombstone(...args: Parameters<Calendar['tombstone']>): void {
        if (TombstoneFailingCalendar.failing) throw new Error('the index transaction failed');
        super.tombstone(...args);
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
        rmSync(CALENDAR_TEST_ROOT, { recursive: true, force: true });
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

    test('two concurrent attendee updates keep both answers, and the byte counter stays exact', async () => {
        const harness = await makeCalendar();
        const calendarId = await defaultCalendarId(harness);
        const created = await harness.instance.createEvent(calendarId, {
            title: 'Standup',
            startTime: new Date('2026-04-01T10:00:00Z'),
            endTime: new Date('2026-04-01T11:00:00Z'),
            allDay: false,
            data: {
                attendees: [
                    { email: 'one@test.local', status: 'pending', role: 'required' },
                    { email: 'two@test.local', status: 'pending', role: 'required' },
                ],
            },
        });

        await Promise.all([
            harness.instance.updateAttendeeStatus(created.id, 'one@test.local', 'accepted'),
            harness.instance.updateAttendeeStatus(created.id, 'two@test.local', 'declined'),
        ]);

        const stored = (await harness.instance.getRawEvents(calendarId))[0];
        expect(stored.data?.attendees?.map((a) => a.status).sort()).toEqual(['accepted', 'declined']);
        expect(await harness.instance.size()).toBe(statSync(fileOf(harness, calendarId, stored.uri)).size);
    });

    test('a write past the resource ceiling answers 413 and stores nothing', async () => {
        const harness = await makeCalendar();
        const calendarId = await defaultCalendarId(harness);

        const write = harness.instance.createEvent(calendarId, {
            title: 'Too big',
            description: 'x'.repeat(EVENT_MAX_BYTES),
            startTime: new Date('2026-04-01T10:00:00Z'),
            endTime: new Date('2026-04-01T11:00:00Z'),
            allDay: false,
        });

        expect(write).rejects.toMatchObject({ status: 413 });
        await write.catch(() => {});
        expect(await harness.instance.listResources(calendarId)).toHaveLength(0);
        expect(readdirSync(join(calendarsDirOf(harness.dir), calendarId))).toHaveLength(0);
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

    test('a roll-back that failed once is owed at the next open, with every event back under its id', async () => {
        const harness = await makeCalendar((homeDir) => new MoveFailingFilesystem(`${homeDir}/${PATHS.CALENDAR.ROOT}`));
        const cal = await harness.instance.createCalendar({ name: 'Retried', color: '#2563eb' });
        await put(harness.instance, cal.id, 'kept.ics', vcal(event('kept@eigen', 'Kept')));
        const storedId = (await harness.instance.getRawEvents(cal.id))[0].id;

        renameSync(
            join(calendarsDirOf(harness.dir), cal.id),
            join(calendarsDirOf(harness.dir), `.${cal.id}.deleting-${randomUUID()}`),
        );

        // The sweep's roll-back throws, and the index pass behind it leaves an empty directory under the id.
        MoveFailingFilesystem.failNextMove = true;
        const failed = await harness.reopen();
        expect(await failed.instance.getRawEvents(cal.id)).toHaveLength(0);

        const restarted = await failed.reopen();
        try {
            expect((await restarted.instance.getRawEvents(cal.id)).map((r) => r.id)).toEqual([storedId]);
            expect(readFileSync(fileOf(harness, cal.id, 'kept.ics'), 'utf8')).toContain('SUMMARY:Kept');
            expect(readdirSync(calendarsDirOf(harness.dir)).some((name) => name.includes('.deleting-'))).toBe(false);
        } finally {
            await restarted.close();
        }
    });

    test('a calendar delete whose commit fails keeps its events, and a PUT in between loses nothing', async () => {
        const harness = await makeCalendar();
        const cal = await harness.instance.createCalendar({ name: 'Refused', color: '#2563eb' });
        await put(harness.instance, cal.id, 'kept.ics', vcal(event('kept@eigen', 'Kept')));

        harness.instance.db.run(
            sql`CREATE TRIGGER refuse_delete BEFORE DELETE ON calendars BEGIN SELECT RAISE(ABORT, 'the index transaction failed'); END`,
        );
        await expect(harness.instance.deleteCalendar(cal.id)).rejects.toThrow('the index transaction failed');
        harness.instance.db.run(sql`DROP TRIGGER refuse_delete`);

        // The rename is rolled back where it happened, so the next write lands beside what was staged.
        expect(readFileSync(fileOf(harness, cal.id, 'kept.ics'), 'utf8')).toContain('SUMMARY:Kept');
        expect((await put(harness.instance, cal.id, 'added.ics', vcal(event('added@eigen', 'Added')))).ok).toBe(true);

        const restarted = await harness.reopen();
        try {
            expect((await restarted.instance.getRawEvents(cal.id)).map((r) => r.title).sort()).toEqual([
                'Added',
                'Kept',
            ]);
        } finally {
            await restarted.close();
        }
    });

    test('a calendar created at a deleted id starts empty, and the staging that delete left is gone', async () => {
        const harness = await makeCalendar(
            (homeDir) => new RemoveFailingFilesystem(`${homeDir}/${PATHS.CALENDAR.ROOT}`),
        );
        const cal = await harness.instance.createCalendar({ name: 'Reused', color: '#2563eb', id: 'reused' });
        await put(harness.instance, cal.id, 'old.ics', vcal(event('old@eigen', 'Old')));

        // The row delete committed; removing the staged directory is what died.
        RemoveFailingFilesystem.failRemoveDir = true;
        await expect(harness.instance.deleteCalendar(cal.id)).rejects.toThrow('the directory removal failed');
        RemoveFailingFilesystem.failRemoveDir = false;
        expect(await harness.instance.getCalendarById(cal.id)).toBeNull();

        const fresh = await harness.instance.createCalendar({ name: 'Fresh', color: '#16a34a', id: 'reused' });
        expect(readdirSync(calendarsDirOf(harness.dir)).some((name) => name.includes('.deleting-'))).toBe(false);

        const restarted = await harness.reopen();
        try {
            expect(await restarted.instance.getRawEvents(fresh.id)).toHaveLength(0);
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

    test('a PUT that puts back what an out-of-band edit changed is written, not answered as a no-op', async () => {
        const harness = await makeCalendar();
        const calendarId = await defaultCalendarId(harness);
        await put(harness.instance, calendarId, 'restored.ics', vcal(event('restored@eigen', 'Original')));
        const original = readFileSync(fileOf(harness, calendarId, 'restored.ics'), 'utf8');
        const ctag = (await harness.instance.getCollection(calendarId))!.ctag;

        // An edit the index never saw: the row still describes the bytes that were there before it.
        writeFileSync(
            fileOf(harness, calendarId, 'restored.ics'),
            original.replace('SUMMARY:Original', 'SUMMARY:Tampered'),
        );

        const result = await put(harness.instance, calendarId, 'restored.ics', original);
        expect(result.ok).toBe(true);
        expect(readFileSync(fileOf(harness, calendarId, 'restored.ics'), 'utf8')).toContain('SUMMARY:Original');
        expect((await harness.instance.getCollection(calendarId))!.ctag).toBeGreaterThan(ctag);
    });

    test('a linked copy takes the alarms a client sends, never the Eigen lines inside them', async () => {
        const harness = await makeCalendar();
        const calendarId = await defaultCalendarId(harness);
        await put(harness.instance, calendarId, 'linked.ics', vcal(event('linked@eigen', 'Linked')));
        const path = fileOf(harness, calendarId, 'linked.ics');
        // The organizer stamp the server writes on an attendee's copy: a PUT may re-alarm it and no more.
        writeFileSync(
            path,
            readFileSync(path, 'utf8').replace(
                'SUMMARY:Linked',
                'SUMMARY:Linked\r\nX-EIGEN-ORGANIZER-EVENT:organizer-1',
            ),
        );

        const result = await put(
            harness.instance,
            calendarId,
            'linked.ics',
            vcal(
                event('linked@eigen', 'Renamed', [
                    'BEGIN:VALARM',
                    'ACTION:DISPLAY',
                    'DESCRIPTION:Reminder',
                    'TRIGGER:-PT10M',
                    'X-EIGEN-EVENT-ID:forged-by-the-client',
                    'END:VALARM',
                ]),
            ),
        );
        expect(result.ok).toBe(true);

        const stored = readFileSync(path, 'utf8');
        expect(stored).toContain('TRIGGER:-PT10M');
        expect(stored).toContain('SUMMARY:Linked');
        expect(stored).not.toContain('forged-by-the-client');
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

    test('a new file whose commit never ran is indexed at the next open', async () => {
        let storage!: DyingFilesystem;
        const harness = await makeCalendar((homeDir) => {
            storage = new DyingFilesystem(`${homeDir}/${PATHS.CALENDAR.ROOT}`);
            return storage;
        });
        const calendarId = await defaultCalendarId(harness);

        // A name nothing indexed yet: no journal row and no resource row, so only the stat diff can find it.
        storage.dieAfterWrite = true;
        await expect(
            put(harness.instance, calendarId, 'fresh.ics', vcal(event('fresh@eigen', 'Fresh'))),
        ).rejects.toThrow('the process died after the rename');

        const restarted = await harness.reopen();
        try {
            const rows = await restarted.instance.getRawEvents(calendarId);
            expect(rows.map((r) => r.title)).toEqual(['Fresh']);
            const served = await restarted.instance.getResource(calendarId, 'fresh.ics');
            expect(rows[0].etag).toBe(served!.etag);
        } finally {
            await restarted.close();
        }
    });

    test('a staged delete is left alone while its calendar holds files again, and never merged into it', async () => {
        const harness = await makeCalendar();
        const cal = await harness.instance.createCalendar({ name: 'Recreated', color: '#2563eb' });
        await put(harness.instance, cal.id, 'live.ics', vcal(event('live@eigen', 'Live')));

        // Two directories both holding files: whichever delete left this one, no sweep may destroy it.
        const staged = join(calendarsDirOf(harness.dir), `.${cal.id}.deleting-${randomUUID()}`);
        mkdirSync(staged, { recursive: true });
        writeFileSync(join(staged, 'stale.ics'), vcal(event('stale@eigen', 'Stale')));

        const restarted = await harness.reopen();
        try {
            expect((await restarted.instance.getRawEvents(cal.id)).map((r) => r.title)).toEqual(['Live']);
            const leftovers = readdirSync(calendarsDirOf(harness.dir)).filter((name) => name.includes('.deleting-'));
            expect(leftovers).toHaveLength(1);
            expect(readdirSync(join(calendarsDirOf(harness.dir), leftovers[0]))).toEqual(['stale.ics']);
        } finally {
            await restarted.close();
        }
    });

    test('a calendar whose directory cannot be scanned is skipped, and the rest of the home opens', async () => {
        const harness = await makeCalendar();
        const healthy = await defaultCalendarId(harness);
        const broken = await harness.instance.createCalendar({ name: 'Broken', color: '#2563eb', id: 'broken' });
        await put(harness.instance, healthy, 'fine.ics', vcal(event('fine@eigen', 'Fine')));
        await put(harness.instance, broken.id, 'blocked.ics', vcal(event('blocked@eigen', 'Blocked')));
        const brokenCtag = (await harness.instance.getCollection(broken.id))!.ctag;

        // A plain file where the directory belongs: every phase-1 call on it throws.
        rmSync(join(calendarsDirOf(harness.dir), broken.id), { recursive: true, force: true });
        writeFileSync(join(calendarsDirOf(harness.dir), broken.id), 'not a directory');

        const restarted = await harness.reopen();
        try {
            expect((await restarted.instance.getRawEvents(healthy)).map((r) => r.title)).toEqual(['Fine']);
            // Unscannable is not "every file vanished": the stale rows stay and nothing is tombstoned.
            expect((await restarted.instance.listResources(broken.id)).map((r) => r.uri)).toEqual(['blocked.ics']);
            expect(await restarted.instance.getDeletedResourcesSince(broken.id, brokenCtag)).toHaveLength(0);
            expect(readFileSync(join(calendarsDirOf(harness.dir), broken.id), 'utf8')).toBe('not a directory');
        } finally {
            await restarted.close();
        }
    });

    test('an index transaction that fails leaves the index stale and still opens the home', async () => {
        const harness = await makeTestHome(
            (home) => new TombstoneFailingCalendar(home, calendarStorage(home.homeDir)),
            CALENDAR_TEST_ROOT,
        );
        const calendarId = await defaultCalendarId(harness);
        await put(harness.instance, calendarId, 'vanishing.ics', vcal(event('vanishing@eigen', 'Vanishing')));

        // One resource gone and one new file waiting: phase 2 fails on the first, phase 3 never runs.
        rmSync(fileOf(harness, calendarId, 'vanishing.ics'));
        writeFileSync(fileOf(harness, calendarId, 'new.ics'), vcal(event('new@eigen', 'New')));

        TombstoneFailingCalendar.failing = true;
        const restarted = await harness.reopen();
        TombstoneFailingCalendar.failing = false;
        try {
            expect((await restarted.instance.listResources(calendarId)).map((r) => r.uri)).toEqual(['vanishing.ics']);
            expect(readFileSync(fileOf(harness, calendarId, 'new.ics'), 'utf8')).toContain('SUMMARY:New');
        } finally {
            await restarted.close();
        }
    });

    test('a directory whose id another calendar already holds in another case is left alone', async () => {
        const harness = await makeCalendar();
        const cal = await harness.instance.createCalendar({ name: 'Work', color: '#2563eb', id: 'Work' });
        await put(harness.instance, cal.id, 'shift.ics', vcal(event('shift@eigen', 'Shift')));
        const before = (await harness.instance.getCalendars()).map((c) => c.id).sort();

        // A tree carried over from a case-sensitive file system: one directory, spelled the other way.
        renameSync(join(calendarsDirOf(harness.dir), 'Work'), join(calendarsDirOf(harness.dir), 'work'));

        const restarted = await harness.reopen();
        try {
            expect((await restarted.instance.getCalendars()).map((c) => c.id).sort()).toEqual(before);
            expect((await restarted.instance.getRawEvents(cal.id)).map((r) => r.title)).toEqual(['Shift']);
        } finally {
            await restarted.close();
        }
    });

    test('a calendar row whose directory vanished keeps the row and tombstones what it indexed', async () => {
        const harness = await makeCalendar();
        const cal = await harness.instance.createCalendar({ name: 'Wiped', color: '#2563eb' });
        await put(harness.instance, cal.id, 'wiped.ics', vcal(event('wiped@eigen', 'Wiped')));
        const ctag = (await harness.instance.getCollection(cal.id))!.ctag;

        rmSync(join(calendarsDirOf(harness.dir), cal.id), { recursive: true, force: true });

        const restarted = await harness.reopen();
        try {
            // The calendar is what the user created; only its contents are gone.
            expect((await restarted.instance.getCalendarById(cal.id))?.name).toBe('Wiped');
            expect(readdirSync(join(calendarsDirOf(harness.dir), cal.id))).toEqual([]);
            expect(await restarted.instance.listResources(cal.id)).toHaveLength(0);
            expect((await restarted.instance.getDeletedResourcesSince(cal.id, ctag)).map((d) => d.uri)).toEqual([
                'wiped.ics',
            ]);
        } finally {
            await restarted.close();
        }
    });

    test('a calendar directory renamed by hand comes back as its new name, and the old row stays empty', async () => {
        const harness = await makeCalendar();
        const cal = await harness.instance.createCalendar({ name: 'Trips', color: '#2563eb', id: 'trips' });
        await put(harness.instance, cal.id, 'trip.ics', vcal(event('trip@eigen', 'Trip')));
        const storedId = (await harness.instance.getRawEvents(cal.id))[0].id;

        renameSync(join(calendarsDirOf(harness.dir), 'trips'), join(calendarsDirOf(harness.dir), 'journeys'));

        const restarted = await harness.reopen();
        try {
            const rows = await restarted.instance.getRawEvents('journeys');
            expect(rows.map((r) => r.id)).toEqual([storedId]);
            // The row the user created is not deleted by a rename nobody told the index about.
            expect(await restarted.instance.listResources(cal.id)).toHaveLength(0);
            expect((await restarted.instance.getCalendarById(cal.id))?.name).toBe('Trips');
        } finally {
            await restarted.close();
        }
    });

    test('a file the dedupe discards does not push a later file off its own event ids', async () => {
        const harness = await makeCalendar();
        const calendarId = await defaultCalendarId(harness);
        const loserId = randomUUID();
        const files: [string, string, string][] = [
            ['a.ics', 'twin@eigen', randomUUID()],
            // Same UID as a.ics, so the dedupe drops it — with the ids it claimed.
            ['b.ics', 'twin@eigen', loserId],
            ['c.ics', 'solo@eigen', loserId],
        ];
        for (const [uri, uid, id] of files) {
            writeFileSync(fileOf(harness, calendarId, uri), vcal(event(uid, 'Planted', [`X-EIGEN-EVENT-ID:${id}`])));
        }

        const restarted = await harness.reopen();
        try {
            const rows = await restarted.instance.getRawEvents(calendarId);
            expect(rows.find((r) => r.uid === 'solo@eigen')!.id).toBe(loserId);
            expect(readFileSync(fileOf(harness, calendarId, 'c.ics'), 'utf8')).toContain(loserId);
        } finally {
            await restarted.close();
        }
    });

    test('a resource with two masters for one UID keeps the first, and an override-only file stands alone', async () => {
        const harness = await makeCalendar();
        const calendarId = await defaultCalendarId(harness);

        // RFC 4791 § 4.1 allows a resource that holds overrides only; its override is an event of its own.
        const result = await put(
            harness.instance,
            calendarId,
            'detached.ics',
            vcal([
                'BEGIN:VEVENT',
                'UID:detached@eigen',
                'RECURRENCE-ID:20260408T100000Z',
                'DTSTART:20260408T140000Z',
                'DTEND:20260408T150000Z',
                'SUMMARY:Detached',
                'END:VEVENT',
            ]),
        );
        expect(result.ok).toBe(true);
        const detached = (await harness.instance.getRawEvents(calendarId)).find((r) => r.uid === 'detached@eigen')!;
        expect(detached.recurrenceDate).toBe('2026-04-08');
        expect(detached.parentEventId).toBeNull();

        const first = randomUUID();
        const second = randomUUID();
        writeFileSync(
            fileOf(harness, calendarId, 'twins.ics'),
            vcal(
                event('twins@eigen', 'First master', [`X-EIGEN-EVENT-ID:${first}`, 'RRULE:FREQ=WEEKLY;COUNT=3']),
                event('twins@eigen', 'Second master', [`X-EIGEN-EVENT-ID:${second}`, 'RRULE:FREQ=WEEKLY;COUNT=3']),
                [
                    'BEGIN:VEVENT',
                    'UID:twins@eigen',
                    'RECURRENCE-ID:20260408T100000Z',
                    'DTSTART:20260408T140000Z',
                    'DTEND:20260408T150000Z',
                    'SUMMARY:Override',
                    'END:VEVENT',
                ],
            ),
        );

        const restarted = await harness.reopen();
        try {
            const rows = await restarted.instance.getRawEvents(calendarId);
            expect(rows.find((r) => r.title === 'Override')!.parentEventId).toBe(first);
            expect(
                rows
                    .filter((r) => r.recurrenceDate === null)
                    .map((r) => r.id)
                    .sort(),
            ).toEqual([first, second].sort());
        } finally {
            await restarted.close();
        }
    });

    test('the byte counter follows the files through a write, a replace, a delete and a drain', async () => {
        let storage!: DyingFilesystem;
        const harness = await makeCalendar((homeDir) => {
            storage = new DyingFilesystem(`${homeDir}/${PATHS.CALENDAR.ROOT}`);
            return storage;
        });
        const calendarId = await defaultCalendarId(harness);
        const sizeOnDisk = (uri: string) => statSync(fileOf(harness, calendarId, uri)).size;

        await put(harness.instance, calendarId, 'counted.ics', vcal(event('counted@eigen', 'Counted')));
        expect(await harness.instance.size()).toBe(sizeOnDisk('counted.ics'));

        await put(
            harness.instance,
            calendarId,
            'counted.ics',
            vcal(event('counted@eigen', 'Counted', ['DESCRIPTION:Much longer than it was'])),
        );
        expect(await harness.instance.size()).toBe(sizeOnDisk('counted.ics'));

        storage.dieAfterWrite = true;
        await expect(
            put(harness.instance, calendarId, 'counted.ics', vcal(event('counted@eigen', 'Torn'))),
        ).rejects.toThrow();
        storage.dieAfterWrite = false;
        await harness.instance.listResources(calendarId);
        expect(await harness.instance.size()).toBe(sizeOnDisk('counted.ics'));

        await harness.instance.deleteResource(calendarId, 'counted.ics', { ifMatch: null });
        expect(await harness.instance.size()).toBe(0);
    });

    test('the byte counter holds every file on disk, a reconcile and a calendar delete included', async () => {
        const harness = await makeCalendar();
        const cal = await harness.instance.createCalendar({ name: 'Metered', color: '#2563eb' });
        await put(harness.instance, cal.id, 'real.ics', vcal(event('metered@eigen', 'Metered')));
        // A file no parse can read still occupies the disk it occupies.
        writeFileSync(fileOf(harness, cal.id, 'junk.ics'), 'BEGIN:VCALENDAR\r\nnot really\r\n');
        const bytes = readdirSync(join(calendarsDirOf(harness.dir), cal.id)).reduce(
            (sum, name) => sum + statSync(fileOf(harness, cal.id, name)).size,
            0,
        );

        const restarted = await harness.reopen();
        try {
            expect(await restarted.instance.size()).toBe(bytes);
            await restarted.instance.deleteCalendar(cal.id);
            expect(await restarted.instance.size()).toBe(0);
        } finally {
            await restarted.close();
        }
    });

    // Moving a resource is one rename plus one transaction: the rows keep their ids and no window ever
    // shows the event in both calendars.
    describe('moveEvent', () => {
        const seriesOf = async (harness: TestHome<Calendar>, calendarId: string, uid: string, uri: string) => {
            await put(harness.instance, calendarId, uri, vcal(event(uid, 'Movable')));
            return (await harness.instance.getRawEvents(calendarId)).find((e) => e.uid === uid)!;
        };

        test('the file and its rows re-home together, under the same ids', async () => {
            const harness = await makeCalendar();
            const source = await defaultCalendarId(harness);
            const target = (await harness.instance.createCalendar({ name: 'Target', color: '#2563eb' })).id;
            const moved = await seriesOf(harness, source, 'move-1@eigen', 'movable.ics');

            const after = await harness.instance.moveEvent(source, moved.id, target);

            expect(after.id).toBe(moved.id);
            expect(after.calendarId).toBe(target);
            expect(readdirSync(join(calendarsDirOf(harness.dir), source))).toEqual([]);
            expect(readdirSync(join(calendarsDirOf(harness.dir), target))).toEqual(['movable.ics']);
            expect(await harness.instance.listResources(source)).toHaveLength(0);
            // The source lists the uri as gone exactly once, and the target never as both.
            expect((await harness.instance.getDeletedResourcesSince(source, 0)).map((d) => d.uri)).toEqual([
                'movable.ics',
            ]);
            expect(await harness.instance.getDeletedResourcesSince(target, 0)).toEqual([]);
        });

        test('a target that already holds the UID refuses the move', async () => {
            const harness = await makeCalendar();
            const source = await defaultCalendarId(harness);
            const target = (await harness.instance.createCalendar({ name: 'Target', color: '#2563eb' })).id;
            const moved = await seriesOf(harness, source, 'move-2@eigen', 'a.ics');
            await put(harness.instance, target, 'b.ics', vcal(event('move-2@eigen', 'Twin')));

            await expect(harness.instance.moveEvent(source, moved.id, target)).rejects.toThrow(
                'The target calendar already holds this event',
            );
            expect(readdirSync(join(calendarsDirOf(harness.dir), source))).toEqual(['a.ics']);
        });

        test('a name the target already uses becomes a fresh one', async () => {
            const harness = await makeCalendar();
            const source = await defaultCalendarId(harness);
            const target = (await harness.instance.createCalendar({ name: 'Target', color: '#2563eb' })).id;
            const moved = await seriesOf(harness, source, 'move-3@eigen', 'taken.ics');
            await put(harness.instance, target, 'taken.ics', vcal(event('other@eigen', 'Already there')));

            await harness.instance.moveEvent(source, moved.id, target);

            const names = readdirSync(join(calendarsDirOf(harness.dir), target)).sort();
            expect(names).toHaveLength(2);
            expect(names).toContain('taken.ics');
            expect(await harness.instance.listResources(source)).toHaveLength(0);
        });
    });

    // The window between the staged rename and the row delete: the sweep decides by the row, so a crash
    // there rolls the whole calendar back rather than losing every event of a delete nobody acknowledged.
    test('a calendar delete that died before its commit is rolled back at the next open', async () => {
        let storage!: DyingFilesystem;
        const harness = await makeCalendar((homeDir) => {
            storage = new DyingFilesystem(`${homeDir}/${PATHS.CALENDAR.ROOT}`);
            return storage;
        });
        const doomed = await harness.instance.createCalendar({ name: 'Doomed', color: '#2563eb' });
        await put(harness.instance, doomed.id, 'kept.ics', vcal(event('rollback@eigen', 'Still here')));

        storage.dieAfterMove = true;
        await expect(harness.instance.deleteCalendar(doomed.id)).rejects.toThrow('the process died after the rename');
        storage.dieAfterMove = false;
        expect(readdirSync(calendarsDirOf(harness.dir)).some((name) => name.includes('.deleting-'))).toBe(true);

        const restarted = await harness.reopen();
        try {
            expect((await restarted.instance.getCalendars()).some((c) => c.id === doomed.id)).toBe(true);
            expect((await restarted.instance.getRawEvents(doomed.id)).map((e) => e.title)).toEqual(['Still here']);
            expect(readdirSync(calendarsDirOf(harness.dir)).some((name) => name.includes('.deleting-'))).toBe(false);
        } finally {
            await restarted.close();
        }
    });

    // L37: parentEventId selects WHICH file is written, so it is checked inside the gate against the
    // calendar the caller named.
    describe('an override names its parent', () => {
        const recurring = (uid: string) => vcal(event(uid, 'Weekly', ['RRULE:FREQ=WEEKLY;COUNT=5']));

        test("a parent in another calendar of the home is not this calendar's to override", async () => {
            const harness = await makeCalendar();
            const source = await defaultCalendarId(harness);
            const other = (await harness.instance.createCalendar({ name: 'Other', color: '#2563eb' })).id;
            await put(harness.instance, source, 'series.ics', recurring('parented@eigen'));
            const parent = (await harness.instance.getRawEvents(source))[0];

            await expect(
                harness.instance.createEvent(other, {
                    title: 'Moved occurrence',
                    startTime: new Date('2026-04-08T12:00:00Z'),
                    endTime: new Date('2026-04-08T13:00:00Z'),
                    allDay: false,
                    parentEventId: parent.id,
                    recurrenceDate: '2026-04-08',
                }),
            ).rejects.toThrow('Event not found');
            expect(readdirSync(join(calendarsDirOf(harness.dir), other))).toEqual([]);
        });

        test('a second override of one occurrence replaces the first', async () => {
            const harness = await makeCalendar();
            const calendarId = await defaultCalendarId(harness);
            await put(harness.instance, calendarId, 'series.ics', recurring('override-twice@eigen'));
            const parent = (await harness.instance.getRawEvents(calendarId))[0];
            const override = (title: string) =>
                harness.instance.createEvent(calendarId, {
                    title,
                    startTime: new Date('2026-04-08T12:00:00Z'),
                    endTime: new Date('2026-04-08T13:00:00Z'),
                    allDay: false,
                    parentEventId: parent.id,
                    recurrenceDate: '2026-04-08',
                });

            await override('First take');
            await override('Second take');

            const exceptions = (await harness.instance.getRawEvents(calendarId)).filter((e) => e.parentEventId);
            expect(exceptions.map((e) => e.title)).toEqual(['Second take']);
            expect(await harness.instance.listResources(calendarId)).toHaveLength(1);
        });
    });

    // An import asks "does this Home already hold the UID?" once per series, up to ICS_IMPORT_MAX_EVENTS
    // times in one file, so both Home-wide UID lookups have to seek rather than read every row.
    test('the Home-wide UID lookups seek an index', async () => {
        const harness = await makeCalendar();
        const planOf = (query: { toSQL: () => { sql: string } }): string[] =>
            harness.instance.db
                .all<{ detail: string }>(sql.raw(`EXPLAIN QUERY PLAN ${query.toSQL().sql}`))
                .map((row) => row.detail);

        // The gate's, on the resource the write would collide with.
        expect(
            planOf(
                harness.instance.db
                    .select({ id: schema.resources.id, uri: schema.resources.uri })
                    .from(schema.resources)
                    .where(eq(schema.resources.uid, 'plan@eigen')),
            ),
        ).toEqual(['SEARCH resources USING INDEX idx_resources_uid (uid=?)']);

        // The inbound invitation's, on the event rows the same UID projects to.
        expect(
            planOf(
                harness.instance.db
                    .select({ id: schema.events.id })
                    .from(schema.events)
                    .innerJoin(schema.resources, eq(schema.events.resourceId, schema.resources.id))
                    .where(eq(schema.events.uid, 'plan@eigen')),
            )[0],
        ).toBe('SEARCH events USING INDEX idx_events_uid (uid=?)');
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
