// The sheet's op log on a real mounted Workbook over a real Y.Doc, with a second Y.Doc as the server. The grid mounts
// once: a batch that arrives while it mounts lands in it, and a new snapshot loads into it in place, which keeps the
// view and ends as a joiner's replay. A tab never writes the snapshot.
import { afterAll, afterEach, expect, mock, test } from 'bun:test';
import { installHappyDom } from '@workspace/ui/test/happy-dom';

installHappyDom();

const Y = await import('yjs');
const { WebsocketProvider } = await import('y-websocket');
const { act, createElement, createRef, useLayoutEffect } = await import('react');
const { createRoot } = await import('react-dom/client');
const realCollab = { ...(await import('@workspace/lib/collab')) };
const realSheets = { ...(await import('@workspace/lib/sheets')) };
const {
    decodeSheetsSnapshot,
    decodeSheetsWorkbook,
    encodeSheetsSnapshot,
    readSheetsSnapshotJson,
    writeSheetsSnapshot,
} = realSheets;
const { Workbook } = await import('@workspace/sheet');
const { replaySheetsOps, withMaterializedData } = await import('@workspace/sheet/engine');
type Op = import('@workspace/sheet').Op;
type Sheet = import('@workspace/sheet').Sheet;
type WorkbookInstance = import('@workspace/sheet').WorkbookInstance;
type Selection = import('@workspace/sheet').Selection;
type UseCollabDocOptions = Parameters<typeof import('@workspace/lib/collab').useCollabDoc>[0];
type CollabDocContext = Parameters<NonNullable<UseCollabDocOptions['onInit']>>[0];

// The server's copy. While the link is up, each side's updates reach the other at once.
let peer = new Y.Doc();
let doc = new Y.Doc();
let linked = true;
let provider = new WebsocketProvider('ws://localhost:1', 'test', doc, { connect: false });
// What a test does between the tab's onInit and its first sync, and right after the sync, before React renders.
let afterSync = () => {};
// What a test does once the grid is in the page, before the tab's own effects run.
let afterCommit = () => {};
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
    decodeSheetsWorkbook: (json: string) => {
        decodes++;
        if (decodeFails) throw new Error('decode failed');
        return decodeSheetsWorkbook(json);
    },
}));
afterAll(() => {
    mock.module('@workspace/lib/collab', () => realCollab);
    mock.module('@workspace/lib/sheets', () => realSheets);
});

const { useSheet } = await import('../../../../components/sheets/hooks/use-sheet');

const sheet = (cells: Record<string, string> = {}, id = 's1'): Sheet => ({
    id,
    name: id === 's1' ? 'One' : 'Two',
    order: id === 's1' ? 0 : 1,
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
    afterCommit = () => {};
    linked = true;
    decodes = 0;
    decodeFails = false;
});

// A workbook whose stored snapshot holds `cells`, open in one tab that a peer shares.
async function open(cells: Record<string, string> = {}, sheets = [sheet(cells)], log: Op[][] = []) {
    peer = new Y.Doc();
    writeSheetsSnapshot(peer, encodeSheetsSnapshot(sheets, { computed: true }), null);
    peer.getArray<Op[]>('ops').push(log);
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
    const seen: { data: unknown; loadFailed: boolean; sheetId?: string; selection?: Selection } = {
        data: null,
        loadFailed: false,
    };
    function Host() {
        const { initialData, loadFailed, handleOp } = useSheet('o', 'm', 'p', workbookRef);
        seen.data = initialData;
        seen.loadFailed = loadFailed;
        useLayoutEffect(() => {
            if (initialData) afterCommit();
        }, [initialData]);
        if (!initialData) return null;
        return createElement(Workbook, {
            ref: workbookRef,
            data: initialData,
            onOp: handleOp,
            onChange: (_sheets, sheetId) => {
                seen.sheetId = sheetId;
            },
            hooks: {
                afterSelectionChange: (_id, selection) => {
                    seen.selection = selection;
                },
            },
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
    return { workbookRef, cell, close, seen, container };
}

const peerSends = (ops: Op[]) => peer.getArray<Op[]>('ops').push([ops]);

// The server's compaction: the log's first `folded` batches replayed over the snapshot, swapped in with those batches
// deleted, all in one transaction.
function compact(folded = peer.getArray<Op[]>('ops').length) {
    const batches = peer.getArray<Op[]>('ops').slice(0, folded);
    const stored = decodeSheetsSnapshot(readSheetsSnapshotJson(peer) ?? '');
    const json = encodeSheetsSnapshot(replaySheetsOps(stored, batches), { computed: true });
    writeSheetsSnapshot(peer, json, batches.length);
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

test("a peer's batch that arrives right after a new snapshot is in the grid", async () => {
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

test('a compaction of everything the tab holds keeps the cells and its offline edit, and drops the undo steps', async () => {
    const { workbookRef, cell } = await open({ '1_1': 'stored' });
    peerSends(typed(0, 0, 'peer'));
    await act(async () => workbookRef.current?.setCellFormat(2, 2, 'bl', 1));
    linked = false;
    await act(async () => workbookRef.current?.setCellFormat(3, 3, 'bl', 1));
    compact();
    await reconnect();
    expect([cell(1, 1)?.v, cell(0, 0)?.v, cell(2, 2)?.bl, cell(3, 3)?.bl]).toEqual(['stored', 'peer', 1, 1]);
    expect(doc.getArray('ops').length).toBe(1);
    expect(peer.getArray('ops').length).toBe(1);
    await act(async () => workbookRef.current?.undo());
    expect([cell(2, 2)?.bl, cell(3, 3)?.bl]).toEqual([1, 1]);
    expect(doc.getArray('ops').length).toBe(1);
});

test("a compaction that arrives with a peer's new batch applies the batch once", async () => {
    const { workbookRef, cell } = await open({ '1_1': 'stored' });
    peerSends(typed(0, 0, 'folded'));
    await act(async () => workbookRef.current?.setCellFormat(2, 2, 'bl', 1));
    linked = false;
    compact();
    peerSends(rowInsert);
    await reconnect();
    expect([cell(2, 1)?.v, cell(1, 0)?.v, cell(3, 2)?.bl]).toEqual(['stored', 'folded', 1]);
    expect(JSON.parse(JSON.stringify(workbookRef.current?.getFlowdata()))).toEqual(joinerCells());
});

test("a compaction of the log's first batches leaves the batches after them in the log, and the next batch applies", async () => {
    const { workbookRef, cell } = await open({ '1_1': 'stored' });
    peerSends(typed(0, 0, 'folded'));
    peerSends(typed(0, 1, 'kept'));
    await act(async () => workbookRef.current?.setCellFormat(2, 2, 'bl', 1));
    linked = false;
    compact(1);
    await reconnect();
    expect(doc.getArray('ops').length).toBe(2);
    await act(async () => peerSends(typed(0, 2, 'after')));
    expect([cell(1, 1)?.v, cell(0, 0)?.v, cell(0, 1)?.v, cell(0, 2)?.v, cell(2, 2)?.bl]).toEqual([
        'stored',
        'folded',
        'kept',
        'after',
        1,
    ]);
});

test('a compaction that folded a batch the tab never received shows it', async () => {
    const { cell } = await open({ '1_1': 'stored' });
    linked = false;
    peerSends(typed(0, 0, 'unseen'));
    compact();
    await reconnect();
    expect([cell(1, 1)?.v, cell(0, 0)?.v]).toEqual(['stored', 'unseen']);
});

test('a compaction that folded a batch the tab rejected shows it', async () => {
    const { workbookRef, cell } = await open({ '1_1': 'stored' });
    const workbook = workbookRef.current;
    if (!workbook) throw new Error('no workbook');
    // The tab rolls the batch back, as it does a batch that fails to apply, while the server's replay applies it.
    const { applyOp } = workbook;
    workbook.applyOp = () => {};
    peerSends(typed(0, 0, 'rejected'));
    workbook.applyOp = applyOp;
    expect(cell(0, 0)?.v).toBeUndefined();
    linked = false;
    compact();
    await reconnect();
    expect([cell(1, 1)?.v, cell(0, 0)?.v]).toEqual(['stored', 'rejected']);
});

test('an import that writes a fresh snapshot shows in the grid', async () => {
    const { cell } = await open({ '1_1': 'stored' });
    await act(async () => importOver({ '1_1': 'imported' }));
    expect(cell(1, 1)?.v).toBe('imported');
});

test('a tab after a failed load loads a compaction and unlocks', async () => {
    decodeFails = true;
    const { cell, seen } = await open({ '1_1': 'stored' });
    expect(seen.loadFailed).toBe(true);
    decodeFails = false;
    await act(async () => {
        peerSends(typed(0, 0, 'folded'));
        compact();
    });
    expect(seen.loadFailed).toBe(false);
    expect([cell(1, 1)?.v, cell(0, 0)?.v]).toEqual(['stored', 'folded']);
});

test('a snapshot the tab cannot read keeps the cells on screen and locks the workbook', async () => {
    const { cell, seen } = await open({ '1_1': 'stored' });
    decodeFails = true;
    await act(async () => importOver({ '1_1': 'imported' }));
    expect(seen.loadFailed).toBe(true);
    expect(cell(1, 1)?.v).toBe('stored');
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

// What a fresh joiner shows of the first sheet: the snapshot with the log replayed on top.
function joinerCells() {
    const stored = decodeSheetsSnapshot(readSheetsSnapshotJson(peer) ?? '');
    const [first] = replaySheetsOps(stored, peer.getArray<Op[]>('ops').toArray());
    return JSON.parse(JSON.stringify(withMaterializedData(first).data));
}

const rowInsert: Op[] = [
    {
        op: 'insertRowCol',
        id: 's1',
        path: [],
        value: { type: 'row', index: 0, count: 1, direction: 'lefttop', id: 's1' },
    },
];

const importOver = (cells: Record<string, string>, sheets = [sheet(cells)]) =>
    writeSheetsSnapshot(peer, encodeSheetsSnapshot(sheets, { computed: true }), null);

test("a new snapshot keeps the selection, the scroll, the sheet on screen and the peers' cursors", async () => {
    const { workbookRef, cell, seen, container } = await open({}, [sheet({}), sheet({ '1_1': 'old' }, 's2')]);
    await act(async () => workbookRef.current?.revealSearchMatch({ sheetId: 's2', r: 3, c: 2 }));
    await act(async () =>
        workbookRef.current?.setPresences([
            { clientId: 7, sheetId: 's2', username: 'Ann', color: '#f00', selection: { r: 1, c: 1 } },
        ]),
    );
    const area = container.querySelector<HTMLElement>('.sheet-cell-area');
    if (!area) throw new Error('no cell area');
    area.scrollTop = 40;
    await act(async () => area.dispatchEvent(new Event('scroll')));
    expect(container.querySelectorAll('.sheet-presence-selection').length).toBe(1);

    await act(async () => importOver({}, [sheet({}), sheet({ '1_1': 'imported' }, 's2')]));
    expect(workbookRef.current?.getFlowdata('s2')?.[1]?.[1]?.v).toBe('imported');
    expect(cell(1, 1)?.v).toBe('imported');
    expect(seen.sheetId).toBe('s2');
    expect(seen.selection).toMatchObject({ row: [3, 3], column: [2, 2] });
    expect(container.querySelectorAll('.sheet-presence-selection').length).toBe(1);
    expect(area.isConnected).toBe(true);
    expect(area.scrollTop).toBe(40);
});

test('a tab that slept through a compaction keeps its view and ends as a joiner, its offline edit applied once', async () => {
    const { workbookRef, seen } = await open({ '1_1': 'stored' });
    peerSends(typed(0, 0, 'peer'));
    await act(async () => workbookRef.current?.revealSearchMatch({ sheetId: 's1', r: 3, c: 2 }));
    linked = false;
    await act(async () => workbookRef.current?.setCellFormat(5, 1, 'bl', 1));
    peerSends(rowInsert);
    compact();
    await reconnect();
    expect(seen.selection).toMatchObject({ row: [3, 3], column: [2, 2] });
    expect(peer.getArray('ops').length).toBe(1);
    expect(JSON.parse(JSON.stringify(workbookRef.current?.getFlowdata()))).toEqual(joinerCells());
});

test("a compaction that folded the tab's own batch leaves it in the grid once", async () => {
    const { workbookRef, cell } = await open({ '1_1': 'stored' });
    await act(async () => peerSends(rowInsert));
    await act(async () => workbookRef.current?.setCellFormat(0, 0, 'bl', 1));
    linked = false;
    compact();
    await reconnect();
    expect(doc.getArray('ops').length).toBe(0);
    expect([cell(0, 0)?.bl, cell(2, 1)?.v, cell(3, 1)]).toEqual([1, 'stored', null]);
    expect(JSON.parse(JSON.stringify(workbookRef.current?.getFlowdata()))).toEqual(joinerCells());
});

test('a new snapshot and a batch that arrive before the grid mounts are in the grid once', async () => {
    afterSync = () => {
        importOver({ '1_1': 'imported' });
        peerSends(rowInsert);
    };
    const { workbookRef, cell } = await open({ '1_1': 'old' });
    expect([cell(2, 1)?.v, cell(3, 1)]).toEqual(['imported', null]);
    expect(JSON.parse(JSON.stringify(workbookRef.current?.getFlowdata()))).toEqual(joinerCells());
});

test('a row insert that arrives before the grid mounts moves the rows once', async () => {
    afterSync = () => peerSends(rowInsert);
    const { cell } = await open({ '1_1': 'stored' });
    expect([cell(1, 1), cell(2, 1)?.v, cell(3, 1)]).toEqual([null, 'stored', null]);
});

test('a row insert that arrives once the grid is in the page, before the tab caught up, moves the rows once', async () => {
    afterSync = () => peerSends(typed(0, 0, 'early'));
    afterCommit = () => peerSends(rowInsert);
    const { cell } = await open({ '1_1': 'stored' });
    expect([cell(1, 0)?.v, cell(2, 1)?.v, cell(3, 1)]).toEqual(['early', 'stored', null]);
});

test('a reconnect that loads the workbook before the tab caught up applies a waiting batch once', async () => {
    decodeFails = true;
    afterSync = () => peerSends(rowInsert);
    afterCommit = () => {
        decodeFails = false;
        syncAgain();
    };
    const { cell, seen } = await open({ '1_1': 'stored' });
    expect(seen.loadFailed).toBe(false);
    expect([cell(2, 1)?.v, cell(3, 1)]).toEqual(['stored', null]);
});

test('a batch that lands before the loaded ones while the grid mounts ends as the log', async () => {
    afterSync = () => peer.getArray<Op[]>('ops').insert(0, [rowInsert]);
    const { workbookRef, cell } = await open({ '1_1': 'stored' }, undefined, [typed(1, 1, 'first')]);
    expect([cell(1, 1)?.v, cell(2, 1)?.v]).toEqual(['first', 'stored']);
    expect(JSON.parse(JSON.stringify(workbookRef.current?.getFlowdata()))).toEqual(joinerCells());
});

test('a batch that lands before an applied one, after a compaction left a batch in the log, ends as the log', async () => {
    const log = [typed(0, 0, 'folded'), rowInsert];
    const { workbookRef, cell } = await open({ '1_1': 'stored' }, undefined, log);
    await act(async () => compact(1));
    await act(async () => peerSends(typed(5, 0, 'applied')));
    await act(async () => peer.getArray<Op[]>('ops').insert(1, [typed(5, 0, 'late')]));
    expect([cell(2, 1)?.v, cell(3, 1), cell(5, 0)?.v]).toEqual(['stored', null, 'applied']);
    expect(JSON.parse(JSON.stringify(workbookRef.current?.getFlowdata()))).toEqual(joinerCells());
});

test('a restore that brings back an older snapshot keeps the view and drops the undo steps', async () => {
    const { workbookRef, cell, seen } = await open({ '1_1': 'stored' });
    await act(async () => workbookRef.current?.revealSearchMatch({ sheetId: 's1', r: 3, c: 2 }));
    await act(async () => workbookRef.current?.setCellFormat(2, 2, 'bl', 1));
    await act(async () => importOver({ '1_1': 'restored' }));
    expect(seen.selection).toMatchObject({ row: [3, 3], column: [2, 2] });
    expect([cell(1, 1)?.v, cell(2, 2)]).toEqual(['restored', null]);
    await act(async () => workbookRef.current?.undo());
    expect([cell(1, 1)?.v, cell(2, 2)]).toEqual(['restored', null]);
    expect(doc.getArray('ops').length).toBe(0);
});
