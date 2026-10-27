// The sheet's op log on a real mounted Workbook over a real Y.Doc, with no server behind it. A peer's batch that
// arrives while the grid mounts or remounts lands in the grid that stays. A tab writes the log into the snapshot only
// when it closes connected and alone, so closing one tab never remounts another's grid.
import { afterAll, afterEach, expect, mock, test } from 'bun:test';
import { installHappyDom } from '@workspace/ui/test/happy-dom';

const window = installHappyDom();

const Y = await import('yjs');
const { WebsocketProvider } = await import('y-websocket');
const { act, createElement, createRef } = await import('react');
const { createRoot } = await import('react-dom/client');
const realCollab = await import('@workspace/lib/collab');
const { decodeSheetsSnapshot, encodeSheetsSnapshot } = await import('@workspace/lib/sheets');
const { Workbook } = await import('@workspace/sheet');
type Op = import('@workspace/sheet').Op;
type Sheet = import('@workspace/sheet').Sheet;
type WorkbookInstance = import('@workspace/sheet').WorkbookInstance;
type CollabDocContext = import('@workspace/lib/collab').CollabDocContext;
type UseCollabDocOptions = import('@workspace/lib/collab').UseCollabDocOptions;

// A peer's doc, the server's copy in effect: everything it writes reaches the tab's doc at once.
let peer = new Y.Doc();
let doc = new Y.Doc();
let provider = new WebsocketProvider('ws://localhost:1', 'test', doc, { connect: false });
// What a test does between the tab's onInit and its first sync, and right after the sync, before React renders.
let afterSync = () => {};

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
afterAll(() => {
    mock.module('@workspace/lib/collab', () => realCollab);
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
});

// A workbook whose stored snapshot holds `cells`, open in one tab that a peer shares.
async function open(cells: Record<string, string> = {}) {
    peer = new Y.Doc();
    peer.getMap('state').set('snapshot', encodeSheetsSnapshot([sheet(cells)], { computed: true }));
    doc = new Y.Doc();
    Y.applyUpdate(doc, Y.encodeStateAsUpdate(peer));
    peer.on('update', (update: Uint8Array) => Y.applyUpdate(doc, update, 'peer'));
    provider = new WebsocketProvider('ws://localhost:1', 'test', doc, { connect: false });
    provider.wsconnected = true;
    const workbookRef = createRef<WorkbookInstance>();
    function Host() {
        const { initialData, snapshotVersion, handleOp, onDataChange } = useSheet('o', 'm', 'p', workbookRef);
        if (!initialData) return null;
        return createElement(Workbook, {
            key: snapshotVersion,
            ref: workbookRef,
            data: initialData,
            onChange: onDataChange,
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
    const cell = (r: number, c: number) => workbookRef.current?.getFlowdata()?.[r]?.[c]?.v;
    return { workbookRef, cell, close };
}

const peerSends = (ops: Op[]) => peer.getArray('ops').push([ops]);
const stored = () => decodeSheetsSnapshot(doc.getMap('state').get('snapshot') as string)[0].celldata;

test("a peer's batch that arrives before the grid mounts is in the grid", async () => {
    afterSync = () => peerSends(typed(0, 0, 'early'));
    const { cell } = await open();
    expect(cell(0, 0)).toBe('early');
});

test("a peer's batch that arrives while the grid remounts on a new snapshot is in the new grid", async () => {
    const { cell } = await open({ '1_1': 'old' });
    await act(async () => {
        peer.transact(() => {
            peer.getMap('state').set(
                'snapshot',
                encodeSheetsSnapshot([sheet({ '1_1': 'flushed' })], { computed: true }),
            );
            peer.getArray('ops').delete(0, peer.getArray('ops').length);
        });
        peerSends(typed(0, 0, 'late'));
    });
    expect(cell(1, 1)).toBe('flushed');
    expect(cell(0, 0)).toBe('late');
});

test("a peer's snapshot and batch in one update apply the batch once", async () => {
    const { cell } = await open({ '1_1': 'old' });
    await act(async () => {
        peer.transact(() => {
            peer.getMap('state').set(
                'snapshot',
                encodeSheetsSnapshot([sheet({ '1_1': 'flushed' })], { computed: true }),
            );
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
    expect(cell(2, 1)).toBe('flushed');
});

test('a tab that closes connected and alone writes its edits into the snapshot', async () => {
    const { workbookRef, close } = await open();
    await act(async () => workbookRef.current?.setCellFormat(0, 0, 'bl', 1));
    expect(doc.getArray('ops').length).toBe(1);
    await close();
    expect(doc.getArray('ops').length).toBe(0);
    expect(stored()).toEqual([{ r: 0, c: 0, v: { bl: 1 } }]);
});

test('a tab that closes while another tab is open leaves the log for the last one', async () => {
    const { workbookRef, close } = await open();
    provider.awareness.states.set(doc.clientID + 1, { user: 'peer' });
    await act(async () => workbookRef.current?.setCellFormat(0, 0, 'bl', 1));
    window.dispatchEvent(new window.Event('beforeunload'));
    expect(doc.getArray('ops').length).toBe(1);
    await close();
    expect(doc.getArray('ops').length).toBe(1);
    expect(stored()).toEqual([]);
});

test('a tab that closes offline leaves the log for the next connected close', async () => {
    const { workbookRef, close } = await open();
    await act(async () => workbookRef.current?.setCellFormat(0, 0, 'bl', 1));
    provider.wsconnected = false;
    await close();
    expect(doc.getArray('ops').length).toBe(1);
});
