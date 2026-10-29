import { afterEach, beforeAll, describe, expect, jest, spyOn, test } from 'bun:test';
import type { Op, Sheet } from '@workspace/lib/sheets';
import {
    decodeSheetsWorkbook,
    encodeSheetsSnapshot,
    readSheetsBase,
    readSheetsSnapshotJson,
} from '@workspace/lib/sheets';
import type { DrivePath } from '@workspace/lib/types/drive';
import type { ServerWebSocket } from 'elysia/ws/bun';
import { CLOSE_LINGER_MS, CollabDocument } from '../../lib/collab/collab-document';
import { compactSheetsSnapshot, writeSheetsSnapshotToYjs } from '../../lib/document/sheets';
import type { DocumentTransformRequest, DocumentTransformResponse } from '../../lib/document/transform/protocol';
import { toTransferableText } from '../../lib/document/transform/protocol';
import { documentTransformRunner } from '../../lib/document/transform/runner';
import { getHome } from '../../lib/home/get-home';
import type { Home } from '../../lib/home/home';
import { driveGet, getTestContext } from '../setup';

// A workbook's op log folds into its snapshot when the close timer fires: the server replays the log in the transform
// process and swaps the result in, unless anything touched the document meanwhile.

type SpyConn = ServerWebSocket<undefined> & { readyState: number; sent: Uint8Array[] };

function makeSpyConn(): SpyConn {
    const conn = {
        readyState: 1, // OPEN
        sent: [] as Uint8Array[],
        send(data: Uint8Array) {
            conn.sent.push(data);
        },
        close() {
            conn.readyState = 3;
        },
    };
    return conn as unknown as SpyConn;
}

// One macrotask drains every pending promise continuation, fake timers or not.
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

const SHEETS: Sheet[] = [{ id: 'sheet-1', name: 'Sheet1', order: 0, celldata: [], config: {} }];
const edit = (r: number, c: number, v: string | number): Op[] => [
    { op: 'replace', id: 'sheet-1', path: ['data', r, c], value: { v, m: String(v) } },
];
// immer can't resolve the path, so the replay rejects the whole batch.
const POISON: Op[] = [{ op: 'replace', id: 'sheet-1', path: ['missing', 'deep'], value: 1 }];

type StubbedRun = {
    request: DocumentTransformRequest;
    signal: AbortSignal | undefined;
    settle: (response: DocumentTransformResponse) => void;
};

// The runner answers a compaction when the test says so, so a test can act while one is in flight. Other jobs, such as
// the search extract a real close queues, run as usual.
function stubRunner() {
    const runs: StubbedRun[] = [];
    const original = documentTransformRunner.run;
    documentTransformRunner.run = (request, opts) => {
        if (request.kind !== 'compact') return original.call(documentTransformRunner, request, opts);
        return new Promise((resolve) => runs.push({ request, signal: opts.signal, settle: resolve }));
    };
    return { runs, restore: () => (documentTransformRunner.run = original) };
}

function succeed(run: StubbedRun): void {
    if (run.request.kind !== 'compact') throw new Error(`unexpected ${run.request.kind} job`);
    const snapshot = compactSheetsSnapshot(run.request.snapshot, run.request.batches);
    run.settle({ ok: true, result: { snapshot: toTransferableText(snapshot) }, warnings: [] });
}

function fail(run: StubbedRun): void {
    run.settle({ ok: false, error: { code: 'crashed', message: 'Document transform failed' } });
}

describe('CollabDocument compacts a workbook at close', () => {
    let ctx: Awaited<ReturnType<typeof getTestContext>>;
    let home: Home;
    let mountId: string;
    let rootId: string;

    beforeAll(async () => {
        ctx = await getTestContext();
        mountId = 'default';
        const root = await driveGet<DrivePath>(ctx.alice.user.sessionToken, ctx.alice.user.id, mountId, 'root');
        rootId = root.id;
        home = await getHome(ctx.alice.user.id);
    });

    afterEach(() => {
        jest.useRealTimers();
    });

    // A workbook built outside the registry, with a snapshot and the given log. The drive's close is counted and
    // does nothing, so the test reads the document after it. The timers are fake from here on.
    async function openLingeringSheet(fileName: string, batches: Op[][], computed = false) {
        const created = await home.drive.create(mountId, rootId, fileName, 'sheets');
        const { path } = await home.drive.resolveFile(mountId, created.id);
        const doc = new CollabDocument(home.drive, path);
        await doc.init();
        doc.doc.transact(() => {
            doc.doc.getMap('state').set('snapshot', encodeSheetsSnapshot(SHEETS, { computed }));
            doc.doc.getArray<Op[]>('ops').push(batches);
        });

        let closes = 0;
        let onClose = () => {};
        const originalClose = home.drive.closeCollabDocument;
        home.drive.closeCollabDocument = async () => {
            closes++;
            onClose();
        };
        let touches = 0;
        const originalTouch = home.drive.touchUpdatedAt;
        home.drive.touchUpdatedAt = async () => {
            touches++;
        };
        jest.useFakeTimers();
        return {
            doc,
            ops: doc.doc.getArray<Op[]>('ops'),
            closes: () => closes,
            touches: () => touches,
            nextClose: () => new Promise<void>((resolve) => (onClose = resolve)),
            restore: () => {
                home.drive.closeCollabDocument = originalClose;
                home.drive.touchUpdatedAt = originalTouch;
            },
        };
    }

    // The last socket leaves and the linger runs out.
    function lingerOut(doc: CollabDocument): void {
        const conn = makeSpyConn();
        doc.subscribe(home.user, conn);
        doc.unsubscribe(conn);
        jest.advanceTimersByTime(CLOSE_LINGER_MS);
    }

    test('the close stores the replayed log as the snapshot, empties the log and keeps computed', async () => {
        const sheet = await openLingeringSheet('compaction-stores', [edit(0, 0, 7), POISON, edit(0, 1, 'x')]);
        try {
            const closed = sheet.nextClose();
            lingerOut(sheet.doc);
            jest.useRealTimers();
            await closed;

            const snapshot = readSheetsSnapshotJson(sheet.doc.doc);
            if (!snapshot) throw new Error('no snapshot');
            const { sheets, computed } = decodeSheetsWorkbook(snapshot);
            expect(computed).toBe(false);
            expect(sheets[0].celldata?.map(({ r, c, v }) => [r, c, v?.v])).toEqual([
                [0, 0, 7],
                [0, 1, 'x'],
            ]);
            // The batch the replay rejected is gone with the others.
            expect(sheet.ops.length).toBe(0);
            const base = readSheetsBase(sheet.doc.doc);
            expect(base).toEqual({ id: expect.any(String), compactedFrom: null });

            // The next compaction names the base it folded into.
            sheet.ops.push([edit(1, 0, 3)]);
            const closedAgain = sheet.nextClose();
            jest.useFakeTimers();
            lingerOut(sheet.doc);
            jest.useRealTimers();
            await closedAgain;
            expect(sheet.ops.length).toBe(0);
            expect(readSheetsBase(sheet.doc.doc)?.compactedFrom).toBe(base?.id ?? 'missing');
        } finally {
            sheet.restore();
            sheet.doc.destruct();
        }
    }, 30_000);

    test("the swap doesn't stamp Modified, now or at the close", async () => {
        const stub = stubRunner();
        const sheet = await openLingeringSheet('compaction-untouched', [edit(0, 0, 1)]);
        try {
            lingerOut(sheet.doc);
            expect(stub.runs).toHaveLength(1);
            succeed(stub.runs[0]);
            await tick();
            expect(sheet.ops.length).toBe(0);
            sheet.doc.destruct();
            expect(sheet.touches()).toBe(0);
        } finally {
            stub.restore();
            sheet.restore();
        }
    });

    test('a workbook with an empty log closes at once, with no run', async () => {
        const stub = stubRunner();
        const sheet = await openLingeringSheet('compaction-empty-log', []);
        try {
            lingerOut(sheet.doc);
            expect(stub.runs).toHaveLength(0);
            expect(sheet.closes()).toBe(1);
        } finally {
            stub.restore();
            sheet.restore();
            sheet.doc.destruct();
        }
    });

    test('a subscribe during the run drops the swap and keeps the document open', async () => {
        const stub = stubRunner();
        const sheet = await openLingeringSheet('compaction-subscribe', [edit(0, 0, 1)]);
        try {
            const before = readSheetsSnapshotJson(sheet.doc.doc);
            lingerOut(sheet.doc);
            const late = makeSpyConn();
            sheet.doc.subscribe(home.user, late);
            succeed(stub.runs[0]);
            await tick();

            expect(readSheetsSnapshotJson(sheet.doc.doc)).toBe(before);
            expect(sheet.ops.length).toBe(1);
            expect(sheet.closes()).toBe(0);

            // The next close timer tries again.
            sheet.doc.unsubscribe(late);
            jest.advanceTimersByTime(CLOSE_LINGER_MS);
            expect(stub.runs).toHaveLength(2);
        } finally {
            stub.restore();
            sheet.restore();
            sheet.doc.destruct();
        }
    });

    test('an update during the run drops the swap, and the document lingers again before the next try', async () => {
        const stub = stubRunner();
        const sheet = await openLingeringSheet('compaction-update', [edit(0, 0, 1)]);
        try {
            const before = readSheetsSnapshotJson(sheet.doc.doc);
            lingerOut(sheet.doc);
            sheet.ops.push([edit(0, 1, 2)]);
            succeed(stub.runs[0]);
            await tick();

            expect(readSheetsSnapshotJson(sheet.doc.doc)).toBe(before);
            expect(sheet.ops.length).toBe(2);
            expect(sheet.closes()).toBe(0);

            jest.advanceTimersByTime(CLOSE_LINGER_MS);
            expect(stub.runs).toHaveLength(2);
            succeed(stub.runs[1]);
            await tick();
            expect(sheet.ops.length).toBe(0);
            expect(sheet.closes()).toBe(1);
        } finally {
            stub.restore();
            sheet.restore();
            sheet.doc.destruct();
        }
    });

    test('destruct during the run aborts it, and nothing is swapped or closed', async () => {
        const stub = stubRunner();
        const sheet = await openLingeringSheet('compaction-destruct', [edit(0, 0, 1)]);
        try {
            lingerOut(sheet.doc);
            const [run] = stub.runs;
            expect(run.signal?.aborted).toBe(false);
            sheet.doc.destruct();
            expect(run.signal?.aborted).toBe(true);
            run.settle({ ok: false, error: { code: 'canceled', message: 'Request was canceled' } });
            await tick();
            expect(sheet.closes()).toBe(0);
        } finally {
            stub.restore();
            sheet.restore();
        }
    });

    test('three failed runs in a row, each closing the document, stop the retries until the API restarts', async () => {
        const stub = stubRunner();
        const warn = spyOn(console, 'warn').mockImplementation(() => {});
        const created = await home.drive.create(mountId, rootId, 'compaction-gives-up', 'sheets');
        const open = () => home.drive.getCollabDocument(mountId, created.id);
        const seeded = await open();
        seeded.doc.transact(() => {
            seeded.doc.getMap('state').set('snapshot', encodeSheetsSnapshot(SHEETS, { computed: true }));
            seeded.doc.getArray<Op[]>('ops').push([edit(0, 0, 1)]);
        });
        let onClose = () => {};
        const originalClose = home.drive.closeCollabDocument.bind(home.drive);
        home.drive.closeCollabDocument = async (...args: Parameters<typeof originalClose>) => {
            await originalClose(...args);
            onClose();
        };
        try {
            const opened = new Set<CollabDocument>();
            for (let i = 0; i < 4; i++) {
                const collab = await open();
                opened.add(collab);
                expect(collab.doc.getArray('ops').length).toBe(1);
                const closed = new Promise<void>((resolve) => (onClose = resolve));
                jest.useFakeTimers();
                lingerOut(collab);
                jest.useRealTimers();
                expect(stub.runs).toHaveLength(Math.min(i + 1, 3));
                if (i < 3) fail(stub.runs[i]);
                await closed;
                expect(home.drive.hasCollabDocument(mountId, created.id)).toBe(false);
            }
            // Every open was a new document, read back from data.db.
            expect(opened.size).toBe(4);
            expect(warn.mock.calls.filter((args) => String(args[0]).includes('gave up'))).toHaveLength(1);
        } finally {
            home.drive.closeCollabDocument = originalClose;
            warn.mockRestore();
            stub.restore();
        }
    }, 30_000);

    test('a subscribe and a leave during the run drop the swap, and the document lingers again before the next try', async () => {
        const stub = stubRunner();
        const sheet = await openLingeringSheet('compaction-one-run', [edit(0, 0, 1)]);
        try {
            lingerOut(sheet.doc);
            // A reload during the run: its subscribe makes the result stale, and its leave arms a second timer.
            lingerOut(sheet.doc);
            expect(stub.runs).toHaveLength(1);
            succeed(stub.runs[0]);
            await tick();
            expect(sheet.ops.length).toBe(1);
            expect(sheet.closes()).toBe(0);

            jest.advanceTimersByTime(CLOSE_LINGER_MS);
            expect(stub.runs).toHaveLength(2);
            succeed(stub.runs[1]);
            await tick();
            expect(sheet.ops.length).toBe(0);
            expect(sheet.closes()).toBe(1);
        } finally {
            stub.restore();
            sheet.restore();
            sheet.doc.destruct();
        }
    });
});

describe('a snapshot writer starts a fresh base', () => {
    let home: Home;
    let mountId: string;
    let rootId: string;

    beforeAll(async () => {
        const ctx = await getTestContext();
        mountId = 'default';
        const root = await driveGet<DrivePath>(ctx.alice.user.sessionToken, ctx.alice.user.id, mountId, 'root');
        rootId = root.id;
        home = await getHome(ctx.alice.user.id);
    });

    test('a version restore stamps a fresh base without compactedFrom, in the same transaction', async () => {
        const created = await home.drive.create(mountId, rootId, 'restore-stamps-base', 'sheets');
        const collab = await home.drive.getCollabDocument(mountId, created.id);
        writeSheetsSnapshotToYjs(collab.doc, encodeSheetsSnapshot(SHEETS, { computed: true }));
        const saved = readSheetsBase(collab.doc);
        const version = await home.drive.saveVersion(mountId, created.id);
        collab.doc.getArray<Op[]>('ops').push([edit(0, 0, 1)]);

        let updates = 0;
        const count = () => updates++;
        collab.doc.on('update', count);
        await home.drive.restoreContainer(mountId, created.id, version.name);
        collab.doc.off('update', count);

        expect(updates).toBe(1);
        const base = readSheetsBase(collab.doc);
        expect(base).toEqual({ id: expect.any(String), compactedFrom: null });
        expect(base?.id).not.toBe(saved?.id);
        await home.drive.closeCollabDocument(mountId, created.id);
    });
});
