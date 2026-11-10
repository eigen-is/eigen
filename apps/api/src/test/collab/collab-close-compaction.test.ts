import { afterEach, beforeAll, describe, expect, jest, spyOn, test } from 'bun:test';
import type { Op, Sheet } from '@workspace/lib/sheets';
import {
    decodeSheetsWorkbook,
    encodeSheetsSnapshot,
    readSheetsBase,
    readSheetsSnapshotJson,
    sheetsOpLog,
    sheetsStateMap,
    writeSheetsSnapshot,
} from '@workspace/lib/sheets';
import type { DrivePath } from '@workspace/lib/types/drive';
import type { ServerWebSocket } from 'elysia/ws/bun';
import * as encoding from 'lib0/encoding';
import * as syncProtocol from 'y-protocols/sync';
import * as Y from 'yjs';
import { CLOSE_LINGER_MS, CollabDocument, MESSAGE_SYNC } from '../../lib/collab/collab-document';
import { readYjsStateFromFile } from '../../lib/collab/yjs-loader';
import { ApiError } from '../../lib/core/errors';
import { compactSheetsSnapshot } from '../../lib/document/sheets';
import type { DocumentTransformRequest, DocumentTransformResponse } from '../../lib/document/transform/protocol';
import { toTransferableText } from '../../lib/document/transform/protocol';
import { BUSY_MESSAGE, documentTransformRunner } from '../../lib/document/transform/runner';
import { getHome } from '../../lib/home/get-home';
import type { Home } from '../../lib/home/home';
import { importIntoDocument } from '../../lib/import/import-document';
import { waitFor } from '../fault-storage-helpers';
import { rowsXml, xlsxFixture } from '../fixtures/xlsx';
import { createTestUser, driveGet, getTestContext } from '../setup';

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

const USER_IDLE_MS = 5 * 60_000;

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
// the search extract a real close queues, run as usual. While `busy` is set, it refuses a compaction as a full queue does.
function stubRunner() {
    const runs: StubbedRun[] = [];
    const state: { busy: boolean; failure: ApiError | null } = { busy: false, failure: null };
    const original = documentTransformRunner.run;
    documentTransformRunner.run = (request, opts) => {
        if (request.kind !== 'compact') return original.call(documentTransformRunner, request, opts);
        if (state.busy) throw new ApiError(503, BUSY_MESSAGE);
        if (state.failure) throw state.failure;
        return new Promise((resolve) => runs.push({ request, signal: opts.signal, settle: resolve }));
    };
    return { runs, state, restore: () => (documentTransformRunner.run = original) };
}

function succeed(run: StubbedRun): void {
    if (run.request.kind !== 'compact') throw new Error(`unexpected ${run.request.kind} job`);
    const { snapshot, dropped } = compactSheetsSnapshot(run.request.snapshot, run.request.batches);
    run.settle({ ok: true, result: { snapshot: toTransferableText(snapshot), dropped }, warnings: [] });
}

function fail(run: StubbedRun): void {
    run.settle({ ok: false, error: { code: 'crashed', message: 'Document transform failed' } });
}

function cancel(run: StubbedRun): void {
    run.settle({ ok: false, error: { code: 'canceled', message: 'Request was canceled' } });
}

function shutDown(run: StubbedRun): void {
    run.settle({ ok: false, error: { code: 'shutdown', message: 'Server is shutting down' } });
}

// The frame a socket sends for an edit that appends the batch to the op log.
function socketEdit(doc: Y.Doc, batch: Op[]): Uint8Array {
    const client = new Y.Doc();
    Y.applyUpdate(client, Y.encodeStateAsUpdate(doc));
    const before = Y.encodeStateVector(client);
    sheetsOpLog(client).push([batch]);
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MESSAGE_SYNC);
    syncProtocol.writeUpdate(encoder, Y.encodeStateAsUpdate(client, before));
    return encoding.toUint8Array(encoder);
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
        const created = await home.drive.create(mountId, rootId, fileName, 'sheets', home.user);
        const { path } = await home.drive.resolveFile(mountId, created.id);
        const doc = await CollabDocument.open(home.drive, path);
        doc.doc.transact(() => {
            sheetsStateMap(doc.doc).set('snapshot', encodeSheetsSnapshot(SHEETS, { computed }));
            sheetsOpLog(doc.doc).push(batches);
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
            id: created.id,
            doc,
            ops: sheetsOpLog(doc.doc),
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

    // A workbook the Drive's registry opens, so each close ends the document and the next open reads data.db again.
    async function registeredSheet(fileName: string, stub: ReturnType<typeof stubRunner>) {
        const created = await home.drive.create(mountId, rootId, fileName, 'sheets', home.user);
        const open = () => home.drive.getCollabDocument(mountId, created.id);
        const seeded = await open();
        seeded.doc.transact(() => {
            sheetsStateMap(seeded.doc).set('snapshot', encodeSheetsSnapshot(SHEETS, { computed: true }));
            sheetsOpLog(seeded.doc).push([edit(0, 0, 1)]);
        });
        let onClose = () => {};
        const originalClose = home.drive.closeCollabDocument.bind(home.drive);
        home.drive.closeCollabDocument = async (...args: Parameters<typeof originalClose>) => {
            await originalClose(...args);
            onClose();
        };
        return {
            id: created.id,
            open,
            // The last socket leaves, a compaction that starts is settled with `settle`, and the document closes. It
            // resolves whether a compaction started.
            closeOnce: async (settle: (run: StubbedRun) => void): Promise<boolean> => {
                const collab = await open();
                const runsBefore = stub.runs.length;
                const closed = new Promise<void>((resolve) => (onClose = resolve));
                jest.useFakeTimers();
                lingerOut(collab);
                jest.useRealTimers();
                const run = stub.runs.at(runsBefore);
                if (run) settle(run);
                await closed;
                expect(home.drive.hasCollabDocument(mountId, created.id)).toBe(false);
                return run !== undefined;
            },
            restore: () => (home.drive.closeCollabDocument = originalClose),
        };
    }

    // The op log of the newest version, read from its data.db as a restore reads it.
    async function newestVersionOps(fileId: string): Promise<Op[][]> {
        const [newest] = await home.drive.listVersions(mountId, fileId);
        if (!newest) throw new Error('no version');
        const { mount } = await home.drive.resolveFile(mountId, fileId);
        const tempId = crypto.randomUUID();
        try {
            const doc = new Y.Doc();
            Y.applyUpdate(doc, readYjsStateFromFile(await mount.downloadToTemp(newest.id, tempId)));
            return sheetsOpLog(doc).toArray();
        } finally {
            await mount.cleanupTemp(tempId);
        }
    }

    test('the close stores the replayed log as the snapshot, empties the log and keeps the computed flag', async () => {
        const warn = spyOn(console, 'warn').mockImplementation(() => {});
        const sheet = await openLingeringSheet('compaction-stores', [edit(0, 0, 7), POISON, edit(0, 1, 'x'), POISON]);
        try {
            // The open stamped a base, which the compaction names as the one it folded.
            const opened = readSheetsBase(sheet.doc.doc);
            expect(opened).toEqual({ id: expect.any(String), compactedFrom: null });
            const closed = sheet.nextClose();
            lingerOut(sheet.doc);
            jest.useRealTimers();
            await closed;

            const snapshot = readSheetsSnapshotJson(sheet.doc.doc);
            if (!snapshot) throw new Error('no snapshot');
            // The workbook was stored uncomputed, and the compaction never recalculates.
            const { sheets, computed } = decodeSheetsWorkbook(snapshot);
            expect(computed).toBe(false);
            expect(sheets[0].celldata?.map(({ r, c, v }) => [r, c, v?.v])).toEqual([
                [0, 0, 7],
                [0, 1, 'x'],
            ]);
            // The batches the replay rejected are gone with the others, and one line names how many.
            expect(sheet.ops.length).toBe(0);
            // Only the sheets lines: a loaded machine also logs slow requests.
            const sheetsLines = warn.mock.calls
                .map((args) => String(args[0]))
                .filter((line) => line.startsWith('[sheets]'));
            expect(sheetsLines).toEqual([`[sheets] compaction dropped 2 op batches path=${sheet.id}`]);
            const base = readSheetsBase(sheet.doc.doc);
            expect(base).toEqual({ id: expect.any(String), compactedFrom: opened?.id ?? 'missing' });

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
            warn.mockRestore();
            sheet.restore();
            sheet.doc.destruct();
        }
    }, 30_000);

    test('a version keeps the log before the swap, with the batch the replay drops', async () => {
        const stub = stubRunner();
        const warn = spyOn(console, 'warn').mockImplementation(() => {});
        const sheet = await openLingeringSheet('compaction-version', [edit(0, 0, 7), POISON]);
        try {
            const versionsBefore = (await home.drive.listVersions(mountId, sheet.id)).length;
            const closed = sheet.nextClose();
            lingerOut(sheet.doc);
            jest.useRealTimers();
            succeed(stub.runs[0]);
            await closed;

            expect(sheet.ops.length).toBe(0);
            expect(await home.drive.listVersions(mountId, sheet.id)).toHaveLength(versionsBefore + 1);
            expect(await newestVersionOps(sheet.id)).toEqual([edit(0, 0, 7), POISON]);
        } finally {
            warn.mockRestore();
            stub.restore();
            sheet.restore();
            sheet.doc.destruct();
        }
    });

    test('a version that fails stops the swap, and the document closes with its log, counting no failure', async () => {
        const stub = stubRunner();
        const warn = spyOn(console, 'warn').mockImplementation(() => {});
        const sheet = await openLingeringSheet('compaction-version-fails', [edit(0, 0, 1)]);
        const originalSave = home.drive.saveVersion;
        home.drive.saveVersion = async () => {
            throw new ApiError(500, 'Storage is down');
        };
        try {
            const before = readSheetsSnapshotJson(sheet.doc.doc);
            // One more close than the failures that stop the compaction.
            for (let i = 0; i < 4; i++) {
                const closed = sheet.nextClose();
                jest.useFakeTimers();
                lingerOut(sheet.doc);
                jest.useRealTimers();
                succeed(stub.runs[i]);
                await closed;
            }

            expect(stub.runs).toHaveLength(4);
            expect(sheet.closes()).toBe(4);
            expect(readSheetsSnapshotJson(sheet.doc.doc)).toBe(before);
            expect(sheet.ops.length).toBe(1);
            expect(warn.mock.calls.filter((args) => String(args[0]).includes('gave up'))).toHaveLength(0);
        } finally {
            home.drive.saveVersion = originalSave;
            warn.mockRestore();
            stub.restore();
            sheet.restore();
            sheet.doc.destruct();
        }
    });

    test("after a swap, the close takes no version of its own, so the session's one version keeps the log", async () => {
        const stub = stubRunner();
        const sheet = await registeredSheet('compaction-one-version', stub);
        try {
            const versionsBefore = (await home.drive.listVersions(mountId, sheet.id)).length;
            expect(await sheet.closeOnce(succeed)).toBe(true);

            expect(await home.drive.listVersions(mountId, sheet.id)).toHaveLength(versionsBefore + 1);
            expect(await newestVersionOps(sheet.id)).toEqual([edit(0, 0, 1)]);
        } finally {
            sheet.restore();
            stub.restore();
        }
    }, 30_000);

    test("the next session's version leaves the first session's copy of the log in place", async () => {
        const stub = stubRunner();
        const sheet = await registeredSheet('compaction-next-session', stub);
        try {
            expect(await sheet.closeOnce(succeed)).toBe(true);
            const [first] = await home.drive.listVersions(mountId, sheet.id);
            sheetsOpLog((await sheet.open()).doc).push([edit(0, 1, 2)]);
            expect(await sheet.closeOnce(succeed)).toBe(true);

            const versions = await home.drive.listVersions(mountId, sheet.id);
            expect(versions.map((version) => version.id)).toContain(first?.id ?? 'missing');
            expect(versions).toHaveLength(2);
            expect(await newestVersionOps(sheet.id)).toEqual([edit(0, 1, 2)]);
        } finally {
            sheet.restore();
            stub.restore();
        }
    }, 30_000);

    test('a close that swaps nothing takes its final version as before', async () => {
        const stub = stubRunner();
        const warn = spyOn(console, 'warn').mockImplementation(() => {});
        const sheet = await registeredSheet('compaction-no-swap-version', stub);
        const originalSave = home.drive.saveVersion;
        home.drive.saveVersion = async () => {
            throw new ApiError(500, 'Storage is down');
        };
        try {
            const versionsBefore = (await home.drive.listVersions(mountId, sheet.id)).length;
            expect(await sheet.closeOnce(succeed)).toBe(true);

            expect(await home.drive.listVersions(mountId, sheet.id)).toHaveLength(versionsBefore + 1);
            expect(await newestVersionOps(sheet.id)).toEqual([edit(0, 0, 1)]);
        } finally {
            home.drive.saveVersion = originalSave;
            sheet.restore();
            warn.mockRestore();
            stub.restore();
        }
    }, 30_000);

    test('an update during the version drops the swap, and the document lingers again', async () => {
        const stub = stubRunner();
        const sheet = await openLingeringSheet('compaction-version-update', [edit(0, 0, 1)]);
        const originalSave = home.drive.saveVersion.bind(home.drive);
        let saved = () => {};
        const versionSaved = new Promise<void>((resolve) => (saved = resolve));
        home.drive.saveVersion = async (...args: Parameters<typeof originalSave>) => {
            sheet.ops.push([edit(0, 1, 2)]);
            const version = await originalSave(...args);
            saved();
            return version;
        };
        try {
            const before = readSheetsSnapshotJson(sheet.doc.doc);
            lingerOut(sheet.doc);
            succeed(stub.runs[0]);
            await versionSaved;
            await tick();

            expect(readSheetsSnapshotJson(sheet.doc.doc)).toBe(before);
            expect(sheet.ops.length).toBe(2);
            expect(sheet.closes()).toBe(0);

            jest.advanceTimersByTime(CLOSE_LINGER_MS);
            expect(stub.runs).toHaveLength(2);
        } finally {
            home.drive.saveVersion = originalSave;
            stub.restore();
            sheet.restore();
            sheet.doc.destruct();
        }
    });

    test('a socket that connects during the version stops the swap and keeps the document open', async () => {
        const stub = stubRunner();
        const sheet = await openLingeringSheet('compaction-version-subscribe', [edit(0, 0, 1)]);
        const late = makeSpyConn();
        const originalSave = home.drive.saveVersion.bind(home.drive);
        let saved = () => {};
        const versionSaved = new Promise<void>((resolve) => (saved = resolve));
        home.drive.saveVersion = async (...args: Parameters<typeof originalSave>) => {
            sheet.doc.subscribe(home.user, late);
            const version = await originalSave(...args);
            saved();
            return version;
        };
        try {
            const before = readSheetsSnapshotJson(sheet.doc.doc);
            lingerOut(sheet.doc);
            succeed(stub.runs[0]);
            await versionSaved;
            await tick();

            expect(readSheetsSnapshotJson(sheet.doc.doc)).toBe(before);
            expect(sheet.ops.length).toBe(1);
            expect(sheet.closes()).toBe(0);
        } finally {
            sheet.doc.unsubscribe(late);
            home.drive.saveVersion = originalSave;
            stub.restore();
            sheet.restore();
            sheet.doc.destruct();
        }
    });

    test("the swap doesn't stamp Modified, now or at the close", async () => {
        const stub = stubRunner();
        const sheet = await openLingeringSheet('compaction-untouched', [edit(0, 0, 1)]);
        try {
            const closed = sheet.nextClose();
            lingerOut(sheet.doc);
            expect(stub.runs).toHaveLength(1);
            succeed(stub.runs[0]);
            await closed;
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

            const closed = sheet.nextClose();
            jest.advanceTimersByTime(CLOSE_LINGER_MS);
            expect(stub.runs).toHaveLength(2);
            succeed(stub.runs[1]);
            await closed;
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
        const sheet = await registeredSheet('compaction-gives-up', stub);
        try {
            const opened = new Set<CollabDocument>();
            for (let i = 0; i < 4; i++) {
                opened.add(await sheet.open());
                expect(await sheet.closeOnce(fail)).toBe(i < 3);
            }
            // Every open was a new document, read back from data.db.
            expect(opened.size).toBe(4);
            const gaveUp = warn.mock.calls.filter((args) => String(args[0]).includes('gave up'));
            expect(gaveUp).toHaveLength(1);
            expect(String(gaveUp[0][0])).toContain(sheet.id);
        } finally {
            sheet.restore();
            warn.mockRestore();
            stub.restore();
        }
    }, 30_000);

    test("a busy runner, a canceled run and a shutdown don't count toward giving up", async () => {
        const stub = stubRunner();
        const warn = spyOn(console, 'warn').mockImplementation(() => {});
        const sheet = await registeredSheet('compaction-not-failures', stub);
        try {
            expect(await sheet.closeOnce(cancel)).toBe(true);
            expect(await sheet.closeOnce(cancel)).toBe(true);
            expect(await sheet.closeOnce(shutDown)).toBe(true);
            stub.state.busy = true;
            for (let i = 0; i < 3; i++) expect(await sheet.closeOnce(fail)).toBe(false);
            stub.state.busy = false;
            expect(await sheet.closeOnce(fail)).toBe(true);
            expect(warn.mock.calls.filter((args) => String(args[0]).includes('gave up'))).toHaveLength(0);
        } finally {
            sheet.restore();
            warn.mockRestore();
            stub.restore();
        }
    }, 30_000);

    test('an ApiError other than the busy 503 counts toward giving up', async () => {
        const stub = stubRunner();
        const warn = spyOn(console, 'warn').mockImplementation(() => {});
        const sheet = await registeredSheet('compaction-api-error-counts', stub);
        try {
            stub.state.failure = new ApiError(413, 'Too large');
            for (let i = 0; i < 3; i++) expect(await sheet.closeOnce(fail)).toBe(false);
            stub.state.failure = null;
            expect(await sheet.closeOnce(fail)).toBe(false);
            expect(warn.mock.calls.filter((args) => String(args[0]).includes('gave up'))).toHaveLength(1);
        } finally {
            sheet.restore();
            warn.mockRestore();
            stub.restore();
        }
    }, 30_000);

    test('a replacing import and a version restore start the failure count over', async () => {
        const stub = stubRunner();
        const warn = spyOn(console, 'warn').mockImplementation(() => {});
        const sheet = await registeredSheet('compaction-count-resets', stub);
        const giveUp = async () => {
            for (let i = 0; i < 3; i++) expect(await sheet.closeOnce(fail)).toBe(true);
            expect(await sheet.closeOnce(fail)).toBe(false);
        };
        const pushEdit = async () => sheetsOpLog((await sheet.open()).doc).push([edit(0, 0, 2)]);
        try {
            await giveUp();
            const { path } = await home.drive.resolveFile(mountId, sheet.id);
            const xlsx = Buffer.from(xlsxFixture({ sheets: [{ name: 'Sheet1', data: rowsXml([['A1', 5]]) }] }));
            await importIntoDocument(home.drive, path, xlsx, { mode: 'replace' }, home.user);
            await pushEdit();
            expect(await sheet.closeOnce(fail)).toBe(true);

            for (let i = 0; i < 2; i++) expect(await sheet.closeOnce(fail)).toBe(true);
            expect(await sheet.closeOnce(fail)).toBe(false);
            const version = await home.drive.saveVersion(mountId, sheet.id);
            await home.drive.restoreContainer(mountId, sheet.id, version.name, home.user);
            await pushEdit();
            expect(await sheet.closeOnce(succeed)).toBe(true);
        } finally {
            sheet.restore();
            warn.mockRestore();
            stub.restore();
        }
    }, 60_000);

    test('the batches cross to the transform process as JSON text', async () => {
        const stub = stubRunner();
        const sheet = await openLingeringSheet('compaction-json-batches', [edit(0, 0, 1), edit(0, 1, 2)]);
        try {
            lingerOut(sheet.doc);
            const [run] = stub.runs;
            if (run.request.kind !== 'compact') throw new Error(`unexpected ${run.request.kind} job`);
            expect(run.request.batches).toBe(JSON.stringify([edit(0, 0, 1), edit(0, 1, 2)]));
            const closed = sheet.nextClose();
            succeed(run);
            await closed;
            expect(sheet.ops.length).toBe(0);
        } finally {
            stub.restore();
            sheet.restore();
            sheet.doc.destruct();
        }
    });

    test('a snapshot in an older format is left as it is, and the document closes with no run', async () => {
        const stub = stubRunner();
        const sheet = await openLingeringSheet('compaction-older-format', [edit(0, 0, 1)]);
        try {
            const older = JSON.stringify(SHEETS);
            sheetsStateMap(sheet.doc.doc).set('snapshot', older);
            lingerOut(sheet.doc);
            expect(stub.runs).toHaveLength(0);
            expect(sheet.closes()).toBe(1);
            expect(readSheetsSnapshotJson(sheet.doc.doc)).toBe(older);
            expect(sheet.ops.length).toBe(1);
        } finally {
            stub.restore();
            sheet.restore();
            sheet.doc.destruct();
        }
    });

    // A tab that comes and goes during the run sends nothing, so it holds the base and every batch the run folded. The
    // swap is right for it, and it keeps its grid when it comes back.
    test('a subscribe and a leave during the run still swap, in one run and one close', async () => {
        const stub = stubRunner();
        const sheet = await openLingeringSheet('compaction-one-run', [edit(0, 0, 1)]);
        try {
            const closed = sheet.nextClose();
            lingerOut(sheet.doc);
            // A reload during the run. Its leave arms a second timer, which finds the run in flight.
            lingerOut(sheet.doc);
            expect(stub.runs).toHaveLength(1);
            succeed(stub.runs[0]);
            await closed;
            expect(sheet.ops.length).toBe(0);
            expect(sheet.closes()).toBe(1);

            jest.advanceTimersByTime(CLOSE_LINGER_MS);
            expect(stub.runs).toHaveLength(1);
            expect(sheet.closes()).toBe(1);
        } finally {
            stub.restore();
            sheet.restore();
            sheet.doc.destruct();
        }
    });

    // Edits over a socket are no requests, so after a long session the Home's last request is older than its idle time.
    // The document holds the Home while it lingers: a reload reattaches, and the workbook compacts before it closes.
    test('a document that lingers on an idle Home keeps the Home open until the linger ends', async () => {
        const stub = stubRunner();
        const owner = await createTestUser('linger-holds-home@test.eigen.is', 'testpassword123', 'Linger Hold');
        const root = await driveGet<DrivePath>(owner.sessionToken, owner.id, mountId, 'root');
        const ownerHome = await getHome(owner.id);
        try {
            const created = await ownerHome.drive.create(
                mountId,
                root.id,
                'linger-holds-home',
                'sheets',
                ownerHome.user,
            );
            const collab = await ownerHome.drive.getCollabDocument(mountId, created.id);
            sheetsStateMap(collab.doc).set('snapshot', encodeSheetsSnapshot(SHEETS, { computed: true }));
            // The op log at each close, read before the destruct.
            const opsAtClose: number[] = [];
            const originalClose = ownerHome.drive.closeCollabDocument.bind(ownerHome.drive);
            ownerHome.drive.closeCollabDocument = async (...args: Parameters<typeof originalClose>) => {
                opsAtClose.push(sheetsOpLog(collab.doc).length);
                return originalClose(...args);
            };

            const now = Date.now();
            jest.useFakeTimers();
            jest.setSystemTime(now - USER_IDLE_MS - 60_000);
            ownerHome.touch();
            jest.setSystemTime(now);
            // A socket session as the route runs it: a hold, a subscribe, an edit, then the unsubscribe and the release.
            const releaseSocket = ownerHome.drive.holdHome();
            const conn = makeSpyConn();
            collab.subscribe(ownerHome.user, conn);
            collab.handleMessage(conn, socketEdit(collab.doc, edit(0, 0, 7)), true);
            collab.unsubscribe(conn);
            releaseSocket();

            jest.advanceTimersByTime(CLOSE_LINGER_MS / 2);
            expect(ownerHome.closing).toBe(false);
            expect(await ownerHome.drive.getCollabDocument(mountId, created.id)).toBe(collab);
            const reload = makeSpyConn();
            collab.subscribe(ownerHome.user, reload);
            collab.unsubscribe(reload);

            jest.advanceTimersByTime(CLOSE_LINGER_MS);
            jest.useRealTimers();
            expect(stub.runs).toHaveLength(1);
            expect(ownerHome.closing).toBe(false);
            succeed(stub.runs[0]);
            await waitFor(() => ownerHome.closing, 10_000);
            expect(opsAtClose).toEqual([0]);
        } finally {
            jest.useRealTimers();
            stub.restore();
            await ownerHome.close();
        }
    }, 30_000);
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

    test('a workbook opened without a base gets one, saved, and its Modified time stays', async () => {
        const created = await home.drive.create(mountId, rootId, 'open-stamps-base', 'sheets', home.user);
        let touches = 0;
        const originalTouch = home.drive.touchUpdatedAt;
        home.drive.touchUpdatedAt = async () => {
            touches++;
        };
        try {
            const collab = await home.drive.getCollabDocument(mountId, created.id);
            const base = readSheetsBase(collab.doc);
            expect(base).toEqual({ id: expect.any(String), compactedFrom: null });
            await home.drive.closeCollabDocument(mountId, created.id);
            expect(touches).toBe(0);

            const reopened = await home.drive.getCollabDocument(mountId, created.id);
            expect(readSheetsBase(reopened.doc)).toEqual(base);
            await home.drive.closeCollabDocument(mountId, created.id);
        } finally {
            home.drive.touchUpdatedAt = originalTouch;
        }
    });

    test('a version restore stamps a fresh base without compactedFrom, in the same transaction', async () => {
        const created = await home.drive.create(mountId, rootId, 'restore-stamps-base', 'sheets', home.user);
        const collab = await home.drive.getCollabDocument(mountId, created.id);
        writeSheetsSnapshot(collab.doc, encodeSheetsSnapshot(SHEETS, { computed: true }), null);
        const saved = readSheetsBase(collab.doc);
        const version = await home.drive.saveVersion(mountId, created.id);
        sheetsOpLog(collab.doc).push([edit(0, 0, 1)]);

        let updates = 0;
        const count = () => updates++;
        collab.doc.on('update', count);
        await home.drive.restoreContainer(mountId, created.id, version.name, home.user);
        collab.doc.off('update', count);

        expect(updates).toBe(1);
        const base = readSheetsBase(collab.doc);
        expect(base).toEqual({ id: expect.any(String), compactedFrom: null });
        expect(base?.id).not.toBe(saved?.id);
        await home.drive.closeCollabDocument(mountId, created.id);
    });
});
