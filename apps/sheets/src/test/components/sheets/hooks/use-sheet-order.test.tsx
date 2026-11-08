// Several tabs, each a real mounted Workbook over its own Y.Doc, and plain Y.Docs for peers and the server. Nothing moves
// between docs until a test delivers it, so a test decides where each batch lands in the op log. Every tab must end
// with the workbook a joiner replays from the snapshot and the log in log order.
import { afterAll, afterEach, expect, mock, test } from 'bun:test';
import { installHappyDom } from '@workspace/ui/test/happy-dom';
import { clickRow } from '@workspace/ui/test/menu-rows';

installHappyDom();

const Y = await import('yjs');
const { WebsocketProvider } = await import('y-websocket');
const { act, createElement, createRef } = await import('react');
const { createRoot } = await import('react-dom/client');
const realCollab = { ...(await import('@workspace/lib/collab')) };
const { decodeSheetsSnapshot, encodeSheetsSnapshot, readSheetsBase, readSheetsSnapshotJson, writeSheetsSnapshot } =
    await import('@workspace/lib/sheets');
const { Workbook } = await import('@workspace/sheet');
const { replaySheetsOps, withMaterializedData } = await import('@workspace/sheet/engine');
type Op = import('@workspace/sheet').Op;
type Sheet = import('@workspace/lib/sheets').Sheet;
type WorkbookInstance = import('@workspace/sheet').WorkbookInstance;
type CollabDocContext = import('@workspace/lib/collab').CollabDocContext;
type UseCollabDocOptions = import('@workspace/lib/collab').UseCollabDocOptions;
type YDoc = import('yjs').Doc;

// Each tab's doc, by the path id its host opens, and the shared hook's sync event again, as a reconnect fires it.
const tabDocs = new Map<string, YDoc>();
const syncs = new Map<string, () => void>();

mock.module('@workspace/lib/collab', () => ({
    ...realCollab,
    useCollabDoc: (options: UseCollabDocOptions) => {
        const { useEffect, useRef } = require('react');
        const doc = tabDocs.get(options.pathId);
        if (!doc) throw new Error(`no doc for ${options.pathId}`);
        const docRef = useRef(doc);
        useEffect(() => {
            const provider = new WebsocketProvider('ws://localhost:1', options.pathId, doc, { connect: false });
            const ctx: CollabDocContext = { doc, provider, undoManager: null };
            const cleanup = options.onInit?.(ctx);
            options.onSync?.(ctx, true);
            syncs.set(options.pathId, () => options.onSync?.(ctx, true));
            return () => {
                cleanup?.();
                provider.destroy();
            };
        }, []);
        return {
            doc,
            docRef,
            provider: null,
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

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
    for (const cleanup of cleanups.splice(0)) await cleanup();
    tabDocs.clear();
    syncs.clear();
});

const sheet = (cells: Record<string, string>): Sheet => ({
    id: 's1',
    name: 'One',
    order: 0,
    row: 12,
    column: 4,
    config: {},
    conditionalFormatRules: [],
    celldata: Object.entries(cells).map(([key, v]) => {
        const [r, c] = key.split('_').map(Number);
        return { r, c, v: { v, m: v } };
    }),
});

// The server's doc: a stored workbook whose snapshot holds `cells`, stamped with a base, and an empty log.
function server(cells: Record<string, string> = {}) {
    const doc = new Y.Doc();
    doc.clientID = 1000;
    writeSheetsSnapshot(doc, encodeSheetsSnapshot([sheet(cells)], { computed: true }), null);
    return doc;
}

// A peer that synced with `from` and then writes on its own. Concurrent batches land in the log by client id, the
// lower one first.
function replica(from: YDoc, clientID: number) {
    const doc = new Y.Doc();
    doc.clientID = clientID;
    Y.applyUpdate(doc, Y.encodeStateAsUpdate(from));
    return doc;
}

const push = (doc: YDoc, ...batches: Op[][]) => {
    for (const ops of batches) doc.getArray<Op[]>('ops').push([ops]);
};

// Everything `from` holds that `to` lacks, as one update, as a reconnect or a relay delivers it.
const deliver = (from: YDoc, to: YDoc) =>
    act(async () => {
        Y.applyUpdate(to, Y.encodeStateAsUpdate(from, Y.encodeStateVector(to)), 'peer');
    });

const typed = (r: number, c: number, v: string): Op[] => [
    { op: 'replace', id: 's1', path: ['data', r, c], value: { v, m: v } },
];

// A tab opened on what `from` holds.
async function openTab(from: YDoc, clientID: number) {
    const doc = replica(from, clientID);
    const pathId = `tab-${clientID}`;
    tabDocs.set(pathId, doc);
    const workbookRef = createRef<WorkbookInstance>();
    const seen = { version: 0 };
    function Host() {
        const { initialData, snapshotVersion, handleOp } = useSheet('o', 'm', pathId, workbookRef);
        seen.version = snapshotVersion;
        if (!initialData) return null;
        return createElement(Workbook, {
            key: snapshotVersion,
            ref: workbookRef,
            data: initialData,
            onOp: handleOp,
        });
    }
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    await act(async () => root.render(createElement(Host)));
    cleanups.push(async () => {
        await act(async () => root.unmount());
        container.remove();
    });
    const workbook = () => {
        if (!workbookRef.current) throw new Error('no workbook');
        return workbookRef.current;
    };
    const edit = (run: (workbook: WorkbookInstance) => void) => act(async () => run(workbook()));
    const cell = (r: number, c: number) => workbook().getFlowdata()?.[r]?.[c] ?? null;
    // Types `text` into a cell through this tab's own cell editor and commits it with Enter, as a person does.
    const type = async (r: number, c: number, text: string) => {
        await edit((w) => w.revealSearchMatch({ sheetId: 's1', r: r, c: c }));
        const input = container.querySelector<HTMLElement>('#sheet-rich-text-editor');
        if (!input) throw new Error('no cell editor');
        input.focus();
        await act(async () => {
            input.dispatchEvent(new KeyboardEvent('keydown', { key: 'x', keyCode: 88, bubbles: true }));
        });
        input.textContent = text;
        await act(async () => {
            input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', keyCode: 13, bubbles: true }));
        });
    };
    return { doc, workbook, edit, cell, type, seen, sync: () => act(async () => syncs.get(pathId)?.()) };
}
type Tab = Awaited<ReturnType<typeof openTab>>;

// What a joiner and a tab hold of the parts these tests write: the cells, the borders and the conditional formats.
const parts = (s: Sheet) =>
    JSON.parse(
        JSON.stringify({
            data: s.data,
            borderInfo: s.config?.borderInfo ?? {},
            rules: s.conditionalFormatRules ?? [],
        }),
    );

function joined(doc: YDoc) {
    const stored = decodeSheetsSnapshot(readSheetsSnapshotJson(doc) ?? '');
    const [first] = replaySheetsOps(stored, doc.getArray<Op[]>('ops').toArray());
    return parts(withMaterializedData(first));
}

function expectJoined(...tabs: Tab[]) {
    for (const tab of tabs) expect(parts(tab.workbook().getAllSheets()[0])).toEqual(joined(tab.doc));
}

const border = (color: string): Op[] => [
    {
        op: 'add',
        id: 's1',
        path: ['config', 'borderInfo', '0_0'],
        value: { rangeType: 'cell', value: { row_index: 0, col_index: 0, t: { style: 1, color } } },
    },
];

const rule = (type: string): Op[] => [
    {
        op: 'add',
        id: 's1',
        path: ['conditionalFormatRules', 0],
        value: { type, cellrange: [{ row: [0, 0], column: [0, 0] }], format: {} },
    },
];

const rowInsert = (index: number): Op[] => [
    { op: 'insertRowCol', id: 's1', path: [], value: { type: 'row', index, count: 1, direction: 'lefttop', id: 's1' } },
];

const opsIn = (doc: YDoc) => doc.getArray<Op[]>('ops').length;
const opsOf = (doc: YDoc) => doc.getArray<Op[]>('ops').toArray();

test('two tabs typing into one cell end with the value later in the log', async () => {
    const s = server();
    const a = await openTab(s, 1);
    const b = await openTab(s, 2);
    await a.edit((w) => w.setCellFormat(2, 1, 'v', '1'));
    await b.edit((w) => w.setCellFormat(2, 1, 'v', '2'));
    await deliver(a.doc, b.doc);
    await deliver(b.doc, a.doc);
    expect([a.cell(2, 1)?.v, b.cell(2, 1)?.v]).toEqual(['2', '2']);
    expectJoined(a, b);
});

test('two peers bordering one cell end with the border later in the log', async () => {
    const s = server();
    const tab = await openTab(s, 3);
    const blue = replica(s, 1);
    const red = replica(s, 2);
    push(blue, border('#0000ff'));
    push(red, border('#ff0000'));
    await deliver(red, tab.doc);
    await deliver(blue, tab.doc);
    expectJoined(tab);
});

test('a batch that arrives last but sits first in the log lands under the others', async () => {
    const s = server();
    const r1 = await openTab(s, 1);
    const l = await openTab(s, 2);
    const r2 = await openTab(s, 3);
    await r1.edit((w) => w.setCellFormat(2, 1, 'v', 'r1'));
    await l.edit((w) => w.setCellFormat(2, 1, 'v', 'l'));
    await r2.edit((w) => w.setCellFormat(2, 1, 'v', 'r2'));
    await deliver(r2.doc, l.doc);
    await deliver(l.doc, r2.doc);
    // R1 comes back online.
    await deliver(r1.doc, l.doc);
    await deliver(r1.doc, r2.doc);
    await deliver(l.doc, r1.doc);
    expect([r1, l, r2].map((tab) => tab.cell(2, 1)?.v)).toEqual(['r2', 'r2', 'r2']);
    expectJoined(r1, l, r2);
});

test('two conditional formats added at once keep the log order', async () => {
    const s = server();
    const tab = await openTab(s, 3);
    const first = replica(s, 1);
    const second = replica(s, 2);
    push(first, rule('colorGradation'));
    push(second, rule('dataBar'));
    await deliver(second, tab.doc);
    await deliver(first, tab.doc);
    expectJoined(tab);
});

test("a peer's row insert before the tab's own edit moves the edit as the log does", async () => {
    const s = server();
    const tab = await openTab(s, 2);
    const peer = replica(s, 1);
    push(peer, rowInsert(2));
    await tab.edit((w) => w.setCellFormat(5, 1, 'v', 'x'));
    await deliver(peer, tab.doc);
    expect(tab.cell(5, 1)?.v).toBe('x');
    expectJoined(tab);
});

test("an edit made outside an event lands after a peer's batch that sits before it in the log", async () => {
    const s = server();
    const tab = await openTab(s, 2);
    const peer = replica(s, 1);
    push(peer, [{ op: 'replace', id: 's1', path: ['data', 0, 0], value: { fc: '#0000ff' } }]);
    tab.workbook().setCellFormat(0, 0, 'fc', '#ff0000');
    await deliver(peer, tab.doc);
    expect(tab.cell(0, 0)?.fc).toBe('#ff0000');
    expectJoined(tab);
});

test('two hundred batches an offline peer sent land at index 1 and the tab ends as the log', async () => {
    const s = server();
    push(s, typed(0, 0, 'first'));
    const offline = replica(s, 1);
    const tab = await openTab(s, 50);
    const online = replica(s, 100);
    for (let i = 0; i < 200; i++) push(offline, typed(i % 10, 1, `offline ${i}`));
    for (let i = 0; i < 5; i++) {
        await tab.edit((w) => w.setCellFormat(i, 1, 'v', `tab ${i}`));
        push(online, typed(i, 2, `online ${i}`));
        await deliver(online, tab.doc);
    }
    await deliver(tab.doc, s);
    await deliver(online, s);
    await deliver(offline, s);
    await deliver(s, tab.doc);
    expect(s.getArray<Op[]>('ops').get(1)).toEqual(offline.getArray<Op[]>('ops').get(1));
    expect(tab.seen.version).toBe(0);
    expect(tab.cell(0, 1)?.v).toBe('tab 0');
    expectJoined(tab);
});

test('one update that lands batches at two places in the log leaves the tab as the log', async () => {
    const s = server();
    const early = replica(s, 1);
    const tab = await openTab(s, 50);
    await tab.edit((w) => w.setCellFormat(0, 0, 'v', 'tab'));
    await deliver(tab.doc, s);
    const late = replica(s, 99);
    push(early, typed(0, 0, 'early'));
    push(late, typed(0, 1, 'late'));
    await deliver(early, s);
    await deliver(late, s);
    await deliver(s, tab.doc);
    expect(tab.seen.version).toBe(0);
    expect([tab.cell(0, 0)?.v, tab.cell(0, 1)?.v]).toEqual(['tab', 'late']);
    expectJoined(tab);
});

test("a peer's edit of another cell that lands before the tab's edit keeps the tab's undo", async () => {
    const s = server();
    const tab = await openTab(s, 2);
    const peer = replica(s, 1);
    push(peer, typed(5, 2, 'peer'));
    await tab.edit((w) => w.setCellFormat(0, 0, 'v', 'mine'));
    await deliver(peer, tab.doc);
    expectJoined(tab);
    await tab.edit((w) => w.undo());
    expect([tab.cell(0, 0)?.v ?? null, tab.cell(5, 2)?.v]).toEqual([null, 'peer']);
    expectJoined(tab);
});

test("a peer's edit of the tab's cell that lands before the tab's edits clears the tab's undo and redo", async () => {
    const s = server();
    const tab = await openTab(s, 2);
    const peer = replica(s, 1);
    push(peer, typed(0, 0, 'peer'));
    await tab.edit((w) => w.setCellFormat(0, 0, 'v', 'mine'));
    await tab.edit((w) => w.setCellFormat(1, 1, 'bl', 1));
    await tab.edit((w) => w.undo());
    await deliver(peer, tab.doc);
    expect(tab.seen.version).toBe(0);
    expect(tab.cell(0, 0)?.v).toBe('mine');
    expectJoined(tab);
    const sent = opsIn(tab.doc);
    await tab.edit((w) => w.redo());
    await tab.edit((w) => w.undo());
    expect(opsIn(tab.doc)).toBe(sent);
    expect([tab.cell(0, 0)?.v, tab.cell(1, 1)?.bl ?? null]).toEqual(['mine', null]);
});

// The recalc list is never stored, but it rides the log, and overwriting a formula sends the whole list. A tab that
// took that list on top of its own new formula would lose the formula from its list, and so from every formula map it
// builds from the list, such as the one after a peer's row op.
test('a formula typed while a peer overwrites another keeps recalculating on the typing tab', async () => {
    const s = server({ '0_0': '1' });
    const a = await openTab(s, 1);
    const b = await openTab(s, 2);
    await a.type(1, 2, '=A1+1');
    await deliver(a.doc, b.doc);
    await a.type(1, 2, '5');
    await b.type(2, 1, '=A1*3');
    await deliver(a.doc, b.doc);
    await deliver(b.doc, a.doc);
    const chain = (sheet: Sheet & { calcChain?: { r: number; c: number }[] }) =>
        sheet.calcChain?.map(({ r, c }) => [r, c]);
    const joiner = replaySheetsOps(decodeSheetsSnapshot(readSheetsSnapshotJson(b.doc) ?? ''), opsOf(b.doc));
    for (const tab of [a, b]) expect(chain(tab.workbook().getAllSheets()[0])).toEqual(chain(joiner[0]));
    const peer = replica(b.doc, 3);
    push(peer, rowInsert(11));
    await deliver(peer, b.doc);
    await b.type(0, 0, '10');
    expect(b.cell(2, 1)?.v).toBe(30);
    expectJoined(b);
});

// A batch of the tab's own can apply before a peer's batch arrives and fail once the log puts the peer's first. The
// formula map learned the batch's formula, so a replay that kept the map would let the next edit of a cell the formula
// reads write the formula back.
test("the tab's own formula that the log's order rejects stays gone after the next edit", async () => {
    const s = server({ '0_0': '1' });
    push(s, [{ op: 'replace', id: 's1', path: ['data', 0, 3], value: { f: '=C1+1', v: 1, m: '1' } }]);
    const tab = await openTab(s, 50);
    const peer = replica(s, 1);
    push(peer, [{ op: 'replace', id: 's1', path: ['data', 0, 3], value: null }]);
    await tab.type(0, 2, '=A1*2');
    await deliver(peer, tab.doc);
    expect(tab.cell(0, 2)).toBeNull();
    await tab.type(0, 0, '5');
    expect(tab.cell(0, 2)).toBeNull();
    expectJoined(tab);
});

// The server's compaction: the log replayed over the snapshot, swapped in with a base that names the one it folded, and
// the folded batches deleted, all in one transaction.
function compact(doc: YDoc) {
    const batches = doc.getArray<Op[]>('ops').toArray();
    const stored = decodeSheetsSnapshot(readSheetsSnapshotJson(doc) ?? '');
    const json = encodeSheetsSnapshot(replaySheetsOps(stored, batches), { computed: true });
    writeSheetsSnapshot(doc, json, readSheetsBase(doc)?.id ?? null);
}

test('a batch that lands before what a kept compaction left keeps the grid and ends as the log', async () => {
    const s = server();
    const tab = await openTab(s, 50);
    const peer = replica(s, 100);
    push(peer, typed(0, 0, 'peer'));
    await deliver(peer, s);
    await deliver(s, tab.doc);
    const offline = replica(s, 1);
    await tab.edit((w) => w.setCellFormat(0, 1, 'v', 'tab'));
    await deliver(tab.doc, s);
    compact(s);
    await deliver(s, tab.doc);
    expect(tab.seen.version).toBe(0);
    await tab.edit((w) => w.setCellFormat(0, 1, 'v', 'after'));
    push(offline, typed(0, 1, 'offline'));
    await deliver(offline, tab.doc);
    expect(tab.seen.version).toBe(0);
    expect(tab.cell(0, 1)?.v).toBe('after');
    expectJoined(tab);
});

test('a batch that lands before the batches the tab replayed at load ends as the log', async () => {
    const s = server();
    const offline = replica(s, 1);
    const writer = replica(s, 100);
    push(writer, typed(0, 0, 'one'), typed(0, 0, 'two'));
    await deliver(writer, s);
    const tab = await openTab(s, 50);
    push(offline, typed(0, 0, 'offline'));
    await deliver(offline, tab.doc);
    expect(tab.doc.getArray<Op[]>('ops').get(0)).toEqual(typed(0, 0, 'offline'));
    expect(tab.seen.version).toBe(1);
    expect(tab.cell(0, 0)?.v).toBe('two');
    expectJoined(tab);
});

// Yjs runs the snapshot's observer first when the server's client id is the lower one, and the log's otherwise.
for (const peerID of [1, 2000]) {
    test(`a batch the tab rejects in the update of a kept compaction remounts it on the next one (peer ${peerID})`, async () => {
        const s = server();
        const tab = await openTab(s, 50);
        await tab.edit((w) => w.setCellFormat(0, 1, 'v', 'tab'));
        await deliver(tab.doc, s);
        compact(s);
        const peer = replica(s, peerID);
        push(peer, [{ op: 'replace', id: 's1', path: ['data', 99, 0, 'v'], value: 1 }]);
        await deliver(peer, s);
        await deliver(s, tab.doc);
        expect(tab.seen.version).toBe(0);
        compact(s);
        await deliver(s, tab.doc);
        expect(tab.seen.version).toBe(1);
        expectJoined(tab);
    });
}

// 220 batches each render the whole workbook, toolbar included, which a loaded machine takes past the 5 s default.
test('a batch that lands before the oldest anchor the tab keeps loads the grid again', async () => {
    const s = server();
    const tab = await openTab(s, 50);
    const offline = replica(s, 1);
    const online = replica(s, 100);
    let recent = replica(s, 2);
    for (let i = 0; i < 220; i++) {
        if (i === 200) recent = replica(tab.doc, 2);
        push(online, typed(0, 0, `online ${i}`));
        await deliver(online, tab.doc);
    }
    push(recent, typed(0, 0, 'recent'));
    await deliver(recent, tab.doc);
    expect(tab.doc.getArray<Op[]>('ops').get(200)).toEqual(typed(0, 0, 'recent'));
    expect(tab.seen.version).toBe(0);
    expectJoined(tab);
    push(offline, typed(0, 0, 'offline'));
    await deliver(offline, tab.doc);
    expect(tab.doc.getArray<Op[]>('ops').get(0)).toEqual(typed(0, 0, 'offline'));
    expect(tab.seen.version).toBe(1);
    expect(tab.cell(0, 0)?.v).toBe('online 219');
    expectJoined(tab);
}, 30_000);

// The sheet tab whose label reads `name`.
const sheetTab = (name: string) =>
    [...document.querySelectorAll('[role="button"] span')].find((span) => span.textContent === name)?.parentElement;

// The tab keeps an anchor inside the observer of its own push, so the anchor at an add or copy must already hold the
// sheet's cell matrix. A rollback to it must leave the open sheet with its cells, and a keystroke there must land.
for (const [name, open, first] of [
    [
        'an added sheet',
        () =>
            act(async () => {
                document.querySelector<HTMLButtonElement>('button[aria-label="New sheet"]')?.click();
                await new Promise((resolve) => setTimeout(resolve));
            }),
        null,
    ],
    [
        'a copied sheet',
        async () => {
            await act(async () => {
                sheetTab('One')?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
            });
            await clickRow('Duplicate');
            await act(async () => sheetTab('One(Copy)')?.click());
        },
        'a',
    ],
] as const) {
    test(`a rollback to the anchor kept at ${name} keeps its cells and takes a keystroke`, async () => {
        const s = server({ '0_0': 'a' });
        const tab = await openTab(s, 50);
        // Nineteen batches, so the sheet's own is the twentieth and the tab keeps an anchor right at it.
        for (let i = 0; i < 19; i++) await tab.edit((w) => w.setCellFormat(i % 10, 1, 'v', `e${i}`));
        await open();
        expect(opsIn(tab.doc)).toBe(20);
        expect(tab.cell(0, 0)?.v ?? null).toBe(first);
        await deliver(tab.doc, s);
        // Two peers send at once. The lower client id sits first in the log but arrives last, and it moves rows.
        const late = replica(s, 100);
        const early = replica(s, 900);
        push(early, typed(5, 3, 'early'));
        push(late, rowInsert(1));
        await deliver(early, tab.doc);
        await deliver(late, tab.doc);
        expect(tab.seen.version).toBe(0);
        expect(tab.cell(0, 0)?.v ?? null).toBe(first);
        await tab.edit((w) => w.setCellFormat(2, 2, 'v', 'typed'));
        expect(tab.cell(2, 2)?.v).toBe('typed');
    });
}

test('rows a peer inserted at the bottom survive a compaction, and a cell typed there reaches a joiner', async () => {
    const s = server({ '0_0': 'base' });
    const tab = await openTab(s, 50);
    const peer = replica(s, 1);
    push(peer, [
        {
            op: 'insertRowCol',
            id: 's1',
            path: [],
            value: { type: 'row', index: 11, count: 2, direction: 'rightbottom' },
        },
    ]);
    await deliver(peer, s);
    await deliver(s, tab.doc);
    compact(s);
    await deliver(s, tab.doc);
    expect(tab.seen.version).toBe(0);
    await tab.edit((w) => w.setCellFormat(13, 0, 'v', 'typed'));
    expect(joined(tab.doc).data[13][0]?.v).toBe('typed');
    expectJoined(tab);
});

// A peer's row op that lands before a row op the tab already applied leaves the tab unable to tell where its selection
// went. The tab drops it and leaves the grid, so a keystroke writes into no cell.
test('a row op that overtakes another row op takes the focus off the grid', async () => {
    const s = server();
    const early = replica(s, 1);
    const tab = await openTab(s, 50);
    const late = replica(s, 100);
    await tab.edit((w) => w.revealSearchMatch({ sheetId: 's1', r: 5, c: 1 }));
    const input = document.getElementById('sheet-rich-text-editor');
    input?.focus();
    expect(document.activeElement === input).toBe(true);
    push(late, rowInsert(0));
    await deliver(late, tab.doc);
    expect(document.activeElement === input).toBe(true);
    push(early, rowInsert(2));
    await deliver(early, tab.doc);
    expect(document.activeElement === input).toBe(false);
    const sent = opsIn(tab.doc);
    await act(async () => {
        input?.dispatchEvent(new KeyboardEvent('keydown', { key: 'x', keyCode: 88, bubbles: true }));
    });
    expect(opsIn(tab.doc)).toBe(sent);
    expectJoined(tab);
});

// A peer's sheet add must not bring back the selection the row delete took, or the keystroke lands on the row that slid
// up.
test("a peer's sheet add after a peer deleted the selected row brings no selection back", async () => {
    const s = server({ '3_0': 'mine', '4_0': 'theirs' });
    const tab = await openTab(s, 50);
    const peer = replica(s, 100);
    await tab.edit((w) => w.revealSearchMatch({ sheetId: 's1', r: 3, c: 0 }));
    const input = document.getElementById('sheet-rich-text-editor');
    input?.focus();
    push(peer, [{ op: 'deleteRowCol', id: 's1', path: [], value: { type: 'row', start: 3, end: 3 } }]);
    push(peer, [{ op: 'addSheet', id: 's2', path: [], value: { ...sheet({}), id: 's2', name: 'Two', order: 1 } }]);
    await deliver(peer, tab.doc);
    const sent = opsIn(tab.doc);
    await act(async () => {
        input?.dispatchEvent(new KeyboardEvent('keydown', { key: 'x', keyCode: 88, bubbles: true }));
    });
    if (input) input.textContent = 'typed';
    await act(async () => {
        input?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', keyCode: 13, bubbles: true }));
    });
    expect(opsIn(tab.doc)).toBe(sent);
    expect(tab.cell(3, 0)?.v).toBe('theirs');
});

// The open cell editor follows its cell when a peer inserts or deletes a row above it, so the text typed there stays in
// the editor and Enter writes it into the cell that moved, as the log has it.
const rowDelete = (index: number): Op[] => [
    { op: 'deleteRowCol', id: 's1', path: [], value: { type: 'row', start: index, end: index } },
];
for (const [name, rowOp, to] of [
    ['insert', rowInsert(2), 6],
    ['delete', rowDelete(1), 4],
] as const) {
    test(`text typed in the open editor survives a peer's row ${name} above and commits into the moved cell`, async () => {
        const s = server();
        const tab = await openTab(s, 50);
        const peer = replica(s, 100);
        await tab.edit((w) => w.revealSearchMatch({ sheetId: 's1', r: 5, c: 1 }));
        const input = document.getElementById('sheet-rich-text-editor');
        input?.focus();
        await act(async () => {
            input?.dispatchEvent(new KeyboardEvent('keydown', { key: 'h', keyCode: 72, bubbles: true }));
        });
        if (input) input.textContent = 'hello';
        push(peer, rowOp);
        await deliver(peer, tab.doc);
        expect(input?.textContent).toBe('hello');
        await act(async () => {
            input?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', keyCode: 13, bubbles: true }));
        });
        expect([tab.cell(5, 1)?.v ?? null, tab.cell(to, 1)?.v]).toEqual([null, 'hello']);
        expectJoined(tab);
    });
}

// A tab sends a batch per keystroke, and the log grows long between two compactions, so the tab's own batch reads none
// of it.
test("the tab's own edit reads no batch of the log", async () => {
    const s = server();
    for (let i = 0; i < 50; i++) push(s, typed(0, 0, `${i}`));
    const tab = await openTab(s, 50);
    const log = tab.doc.getArray<Op[]>('ops');
    let reads = 0;
    const { toArray, slice } = log;
    log.toArray = () => {
        reads += 1;
        return toArray.call(log);
    };
    log.slice = (start, end) => {
        reads += 1;
        return slice.call(log, start, end);
    };
    await tab.edit((w) => w.setCellFormat(1, 1, 'v', 'mine'));
    expect(reads).toBe(0);
    expectJoined(tab);
});

// A sheet add or delete ships the orders its author left, and the replay only appends or drops the sheet. A tab that
// also moved the other sheets would part from the joiner when two such batches cross, and a kept compaction would then
// keep the tab's orders while the snapshot holds the joiner's.
test('a sheet added and one deleted at once leave the tab with the orders a joiner has', async () => {
    const named = (id: string, order: number): Sheet => ({ ...sheet({}), id, name: id, order });
    const s = new Y.Doc();
    s.clientID = 1000;
    const four = [named('s1', 0), named('s2', 1), named('s3', 2), named('s4', 3)];
    writeSheetsSnapshot(s, encodeSheetsSnapshot(four, { computed: true }), null);
    const tab = await openTab(s, 50);
    const adder = replica(s, 5);
    const deleter = replica(s, 20);
    push(adder, [{ op: 'addSheet', id: 's5', path: [], value: { ...named('s5', 4), config: {} } }]);
    push(deleter, [
        { op: 'deleteSheet', id: 's2', path: [], value: { id: 's2' } },
        { op: 'replace', id: 's3', path: ['order'], value: 1 },
        { op: 'replace', id: 's4', path: ['order'], value: 2 },
    ]);
    await deliver(deleter, s);
    await deliver(adder, s);
    await deliver(s, tab.doc);
    const orders = (sheets: Sheet[]) => sheets.map((x) => `${x.id}:${x.order}`).sort();
    const joiner = () => orders(replaySheetsOps(decodeSheetsSnapshot(readSheetsSnapshotJson(s) ?? ''), opsOf(s)));
    expect(orders(tab.workbook().getAllSheets())).toEqual(joiner());
    compact(s);
    await deliver(s, tab.doc);
    expect(tab.seen.version).toBe(0);
    expect(orders(tab.workbook().getAllSheets())).toEqual(joiner());
});

// Only a compaction deletes batches, and it writes the snapshot they went into in the same transaction. A writer that
// deletes the head of the log without one leaves the grid with batches no joiner applies, so the grid loads again.
test('batches deleted from the head of the log without a new snapshot load the grid again', async () => {
    const s = server();
    push(s, typed(0, 0, 'first'), typed(1, 0, 'second'));
    const tab = await openTab(s, 50);
    const writer = replica(s, 1);
    writer.getArray<Op[]>('ops').delete(0, 1);
    await deliver(writer, tab.doc);
    expect(tab.seen.version).toBe(1);
    expect(tab.cell(0, 0)).toBeNull();
    expectJoined(tab);
});
