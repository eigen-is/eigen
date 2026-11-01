// The sheet's op log on a real mounted Workbook over a real Y.Doc, with a second Y.Doc as the server. A peer's batch
// that arrives while the grid mounts or remounts lands in the grid that stays. A tab never writes the snapshot, and it
// keeps its grid through a compaction of what it already holds.
import { afterAll, afterEach, expect, mock, test } from 'bun:test';
import { installHappyDom } from '@workspace/ui/test/happy-dom';

installHappyDom();

const Y = await import('yjs');
const { WebsocketProvider } = await import('y-websocket');
const { act, createElement, createRef } = await import('react');
const { createRoot } = await import('react-dom/client');
const realCollab = { ...(await import('@workspace/lib/collab')) };
const realSheets = { ...(await import('@workspace/lib/sheets')) };
const { decodeSheetsSnapshot, encodeSheetsSnapshot, readSheetsBase, readSheetsSnapshotJson, writeSheetsSnapshot } =
    realSheets;
const { Workbook } = await import('@workspace/sheet');
const { replaySheetsOps } = await import('@workspace/sheet/engine');
type Op = import('@workspace/sheet').Op;
type Sheet = import('@workspace/sheet').Sheet;
type WorkbookInstance = import('@workspace/sheet').WorkbookInstance;
type CollabDocContext = import('@workspace/lib/collab').CollabDocContext;
type UseCollabDocOptions = import('@workspace/lib/collab').UseCollabDocOptions;

// The server's copy. While the link is up, each side's updates reach the other at once.
let peer = new Y.Doc();
let doc = new Y.Doc();
let linked = true;
let provider = new WebsocketProvider('ws://localhost:1', 'test', doc, { connect: false });
// What a test does between the tab's onInit and its first sync, and right after the sync, before React renders.
let afterSync = () => {};
// The shared hook's sync event again, as a reconnect fires it.
let syncAgain = () => {};
// The tab's snapshot decodes, counted, and a switch that makes them fail for now.
let decodes = 0;
let decodeFails = false;

// The shared hook's lifecycle without a socket: onInit, then a synced onSync, and the init's cleanup on unmount.
mock.module('@workspace/lib/collab', () => ({
    ...realCollab,
    useCollabDoc: (options: UseCollabDocOptions) => {
        const { useEffect, useRef } = require('react');
        const docRef = useRef(doc);
        useEffect(() => {
            const ctx: CollabDocContext = { doc, provider, undoManager: null };
            const cleanup = options.onInit?.(ctx);
            options.onSync?.(ctx, true);
            syncAgain = () => options.onSync?.(ctx, true);
            afterSync();
            return () => cleanup?.();
        }, []);
        return {
            doc,
            docRef,
            provider,
            undoManager: null,
            synced: true,
            offline: false,
            loaded: true,
            storageUnavailable: false,
            storageGone: false,
            unsyncedEdits: false,
        };
    },
}));
mock.module('@workspace/lib/sheets', () => ({
    ...realSheets,
    decodeSheetsSnapshot: (json: string) => {
        decodes++;
        if (decodeFails) throw new Error('decode failed');
        return decodeSheetsSnapshot(json);
    },
}));
afterAll(() => {
    mock.module('@workspace/lib/collab', () => realCollab);
    mock.module('@workspace/lib/sheets', () => realSheets);
});

const { useSheet } = await import('../../../../components/sheets/hooks/use-sheet');

const sheet = (cells: Record<string, string> = {}): Sheet => ({
    id: 's1',
    name: 'One',
    order: 0,
    row: 10,
    column: 4,
    config: {},
    celldata: Object.entries(cells).map(([key, v]) => {
        const [r, c] = key.split('_').map(Number);
        return { r, c, v: { v, m: v } };
    }),
});

const typed = (r: number, c: number, v: string): Op[] => [
    { op: 'replace', id: 's1', path: ['data', r, c], value: { v, m: v } },
];

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
    for (const cleanup of cleanups.splice(0)) await cleanup();
    afterSync = () => {};
    linked = true;
    decodes = 0;
    decodeFails = false;
});

// A workbook whose stored snapshot holds `cells`, open in one tab that a peer shares. An import stamps a base, and a
// workbook stored before bases existed has none.
async function open(cells: Record<string, string> = {}, { stamped = true } = {}) {
    peer = new Y.Doc();
    const json = encodeSheetsSnapshot([sheet(cells)], { computed: true });
    if (stamped) writeSheetsSnapshot(peer, json, null);
    else peer.getMap('state').set('snapshot', json);
    doc = new Y.Doc();
    Y.applyUpdate(doc, Y.encodeStateAsUpdate(peer));
    peer.on('update', (update: Uint8Array, origin: unknown) => {
        if (linked && origin !== 'tab') Y.applyUpdate(doc, update, 'peer');
    });
    doc.on('update', (update: Uint8Array, origin: unknown) => {
        if (linked && origin !== 'peer') Y.applyUpdate(peer, update, 'tab');
    });
    provider = new WebsocketProvider('ws://localhost:1', 'test', doc, { connect: false });
    const workbookRef = createRef<WorkbookInstance>();
    const seen: { version: number; data: unknown; loadFailed: boolean } = {
        version: 0,
        data: null,
        loadFailed: false,
    };
    function Host() {
        const { initialData, snapshotVersion, loadFailed, handleOp } = useSheet('o', 'm', 'p', workbookRef);
        seen.version = snapshotVersion;
        seen.data = initialData;
        seen.loadFailed = loadFailed;
        if (!initialData) return null;
        return createElement(Workbook, {
            key: snapshotVersion,
            ref: workbookRef,
            data: initialData,
            onOp: handleOp,
            showToolbar: false,
            showFormulaBar: false,
        });
    }
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    await act(async () => root.render(createElement(Host)));
    const close = async () => {
        await act(async () => root.unmount());
        container.remove();
    };
    cleanups.push(close);
    const cell = (r: number, c: number) => workbookRef.current?.getFlowdata()?.[r]?.[c];
    return { workbookRef, cell, close, seen };
}

const peerSends = (ops: Op[]) => peer.getArray<Op[]>('ops').push([ops]);

// The server's compaction: the log replayed over the snapshot, swapped in with a base that names the one it folded, and
// the folded batches deleted, all in one transaction.
function compact() {
    const batches = peer.getArray<Op[]>('ops').toArray();
    const stored = decodeSheetsSnapshot(readSheetsSnapshotJson(peer) ?? '');
    const json = encodeSheetsSnapshot(replaySheetsOps(stored, batches), { computed: true });
    writeSheetsSnapshot(peer, json, readSheetsBase(peer)?.id ?? null);
}

// The tab is back online: it takes what the server holds that it lacks in one update, and sends what it wrote.
async function reconnect() {
    await act(async () => {
        linked = true;
        Y.applyUpdate(doc, Y.encodeStateAsUpdate(peer, Y.encodeStateVector(doc)), 'peer');
        Y.applyUpdate(peer, Y.encodeStateAsUpdate(doc, Y.encodeStateVector(peer)), 'tab');
        syncAgain();
    });
}

test("a peer's batch that arrives before the grid mounts is in the grid", async () => {
    afterSync = () => peerSends(typed(0, 0, 'early'));
    const { cell } = await open();
    expect(cell(0, 0)?.v).toBe('early');
});

test("a peer's batch that arrives while the grid remounts on a new snapshot is in the new grid", async () => {
    const { cell } = await open({ '1_1': 'old' });
    await act(async () => {
        peer.transact(() => {
            writeSheetsSnapshot(peer, encodeSheetsSnapshot([sheet({ '1_1': 'flushed' })], { computed: true }), null);
        });
        peerSends(typed(0, 0, 'late'));
    });
    expect(cell(1, 1)?.v).toBe('flushed');
    expect(cell(0, 0)?.v).toBe('late');
});

test("a peer's snapshot and batch in one update apply the batch once", async () => {
    const { cell } = await open({ '1_1': 'old' });
    await act(async () => {
        peer.transact(() => {
            writeSheetsSnapshot(peer, encodeSheetsSnapshot([sheet({ '1_1': 'flushed' })], { computed: true }), null);
            peerSends([
                {
                    op: 'insertRowCol',
                    id: 's1',
                    path: [],
                    value: { type: 'row', index: 0, count: 1, direction: 'lefttop', id: 's1' },
                },
            ]);
        });
    });
    expect(cell(2, 1)?.v).toBe('flushed');
});

test('a tab that closes writes no snapshot and leaves its edits in the log', async () => {
    const { workbookRef, close } = await open();
    await act(async () => workbookRef.current?.setCellFormat(0, 0, 'bl', 1));
    const snapshot = readSheetsSnapshotJson(doc);
    await close();
    expect(doc.getArray('ops').length).toBe(1);
    expect(readSheetsSnapshotJson(doc)).toBe(snapshot);
});

test('a compaction of everything the tab holds keeps its grid, its offline edit and the cells, and adopts the base', async () => {
    const { workbookRef, cell, seen } = await open({ '1_1': 'stored' });
    peerSends(typed(0, 0, 'peer'));
    await act(async () => workbookRef.current?.setCellFormat(2, 2, 'bl', 1));
    linked = false;
    await act(async () => workbookRef.current?.setCellFormat(3, 3, 'bl', 1));
    compact();
    await reconnect();
    expect(seen.version).toBe(0);
    expect([cell(1, 1)?.v, cell(0, 0)?.v, cell(2, 2)?.bl, cell(3, 3)?.bl]).toEqual(['stored', 'peer', 1, 1]);
    expect(doc.getArray('ops').length).toBe(1);
    await act(async () => workbookRef.current?.undo());
    expect([cell(2, 2)?.bl, cell(3, 3)?.bl]).toEqual([1, undefined]);

    // A second compaction names the base the first one stamped, which this tab now holds.
    linked = false;
    compact();
    await reconnect();
    expect(seen.version).toBe(0);
    expect(cell(3, 3)?.bl).toBeUndefined();
    await act(async () => workbookRef.current?.undo());
    expect(cell(2, 2)?.bl).toBeUndefined();
});

test("a compaction that arrives with a peer's new batch keeps the grid and applies the batch", async () => {
    const { workbookRef, cell, seen } = await open({ '1_1': 'stored' });
    peerSends(typed(0, 0, 'folded'));
    await act(async () => workbookRef.current?.setCellFormat(2, 2, 'bl', 1));
    linked = false;
    compact();
    peerSends(typed(0, 1, 'live'));
    await reconnect();
    expect(seen.version).toBe(0);
    expect([cell(1, 1)?.v, cell(0, 0)?.v, cell(0, 1)?.v, cell(2, 2)?.bl]).toEqual(['stored', 'folded', 'live', 1]);
    await act(async () => workbookRef.current?.undo());
    expect(cell(2, 2)?.bl).toBeUndefined();
});

test('a compaction that folded a batch the tab never received remounts onto it', async () => {
    const { cell, seen } = await open({ '1_1': 'stored' });
    linked = false;
    peerSends(typed(0, 0, 'unseen'));
    compact();
    await reconnect();
    expect(seen.version).toBe(1);
    expect([cell(1, 1)?.v, cell(0, 0)?.v]).toEqual(['stored', 'unseen']);
});

test('a compaction that folded a batch the tab rejected remounts onto it', async () => {
    const { workbookRef, cell, seen } = await open({ '1_1': 'stored' });
    const workbook = workbookRef.current;
    if (!workbook) throw new Error('no workbook');
    // The tab rolls the batch back, as it does a batch that fails to apply, while the server's replay applies it.
    const { applyOp } = workbook;
    workbook.applyOp = () => false;
    peerSends(typed(0, 0, 'rejected'));
    workbook.applyOp = applyOp;
    expect(cell(0, 0)?.v).toBeUndefined();
    linked = false;
    compact();
    await reconnect();
    expect(seen.version).toBe(1);
    expect([cell(1, 1)?.v, cell(0, 0)?.v]).toEqual(['stored', 'rejected']);
});

test('an import that writes a fresh snapshot remounts the grid', async () => {
    const { cell, seen } = await open({ '1_1': 'stored' });
    await act(async () => {
        peer.transact(() => {
            writeSheetsSnapshot(peer, encodeSheetsSnapshot([sheet({ '1_1': 'imported' })], { computed: true }), null);
        });
    });
    expect(seen.version).toBe(1);
    expect(cell(1, 1)?.v).toBe('imported');
});

test('a tab on a workbook stored before bases existed remounts on its first compaction', async () => {
    const { cell, seen } = await open({ '1_1': 'stored' }, { stamped: false });
    peerSends(typed(0, 0, 'folded'));
    linked = false;
    compact();
    await reconnect();
    expect(seen.version).toBe(1);
    expect([cell(1, 1)?.v, cell(0, 0)?.v]).toEqual(['stored', 'folded']);
});

test('a tab after a failed load remounts on a compaction', async () => {
    decodeFails = true;
    const { cell, seen } = await open({ '1_1': 'stored' });
    expect(seen.loadFailed).toBe(true);
    decodeFails = false;
    await act(async () => {
        peerSends(typed(0, 0, 'folded'));
        compact();
    });
    expect(seen.version).toBe(1);
    expect(seen.loadFailed).toBe(false);
    expect([cell(1, 1)?.v, cell(0, 0)?.v]).toEqual(['stored', 'folded']);
});

test('a reconnect after a failed load loads the workbook and unlocks it', async () => {
    decodeFails = true;
    const { cell, seen } = await open({ '1_1': 'stored' });
    expect(seen.loadFailed).toBe(true);
    decodeFails = false;
    await reconnect();
    expect(seen.loadFailed).toBe(false);
    expect(cell(1, 1)?.v).toBe('stored');
});

test('a reconnect after a good load decodes nothing and keeps the grid', async () => {
    const { seen } = await open({ '1_1': 'stored' });
    const data = seen.data;
    const before = decodes;
    await reconnect();
    expect(decodes).toBe(before);
    expect(seen.data).toBe(data);
});
