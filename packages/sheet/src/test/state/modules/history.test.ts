// Undo and redo with a peer at work. Each case runs two tabs on one workbook, A and B, through the real record, applyOp
// and undo steps, and checks what a user sees: the cell the undo lands in, on A, on B and for a joiner who replays
// every batch. The three must always agree.

import { describe, expect, test } from 'bun:test';
import { DEFAULT_CHART_SERIES_STYLE, newSheetChartSpecParts, sampleChartSpec } from '@workspace/lib/charts';
import type { Patch } from 'immer';
import { produce } from 'immer';
import { generateAPIs } from '../../../components/Workbook/api';
import { dataToCelldata } from '../../../engine/celldata';
import { normalizeSheetConfig } from '../../../engine/sheet-config';
import type { Cell } from '../../../engine/types';
import { setColumnWidth } from '../../../state/api/rowcol';
import { copySheet } from '../../../state/api/sheet';
import type { Context } from '../../../state/context';
import { shiftEntries } from '../../../state/modules/history-shift';
import { saveHyperlink } from '../../../state/modules/hyperlink';
import { mergeCells } from '../../../state/modules/merge';
import { deleteRowCol, insertRowCol } from '../../../state/modules/rowcol';
import { addSheet, changeSheet, deleteSheet } from '../../../state/modules/sheet';
import { defaultSettings } from '../../../state/settings';
import type { History, Op, Sheet } from '../../../state/types';
import type { Tab } from '../factories/collab';
import { author, join, tab, tabEdit, tabReceive, tabRedo, tabUndo } from '../factories/collab';
import { workbookContextFactory } from '../factories/context';
import { typed } from '../factories/edit-cycle';

const ONE = 's1';
const TWO = 's2';
const THREE = 's3';

// 'B10' → [9, 1].
function at(a1: string): [number, number] {
    const [, letters, digits] = /^([A-Z]+)(\d+)$/.exec(a1) ?? [];
    return [Number(digits) - 1, letters.charCodeAt(0) - 65];
}

function sheet(id: string, name: string, order: number, cells: Record<string, Cell> = {}): Sheet {
    const data: (Cell | null)[][] = Array.from({ length: 40 }, () => Array.from({ length: 8 }, () => null));
    const calcChain = [];
    for (const [a1, cell] of Object.entries(cells)) {
        const [r, c] = at(a1);
        data[r][c] = cell;
        if (cell.f) calcChain.push({ r, c, id });
    }
    return { id, name, order, row: 40, column: 8, data, config: {}, calcChain };
}

function workbook(one: Record<string, Cell> = {}, two: Record<string, Cell> = {}, three: Record<string, Cell> = {}) {
    const ctx = workbookContextFactory({
        currentSheetId: ONE,
        sheets: [sheet(ONE, 'One', 0, one), sheet(TWO, 'Two', 1, two), sheet(THREE, 'Three', 2, three)],
    });
    for (const s of ctx.sheets) normalizeSheetConfig(s);
    return ctx;
}

const text = (v: string): Cell => ({ v, m: v, ct: { fa: 'General', t: 'g' } });
const num = (n: number): Cell => ({ v: n, m: String(n), ct: { fa: 'General', t: 'n' } });

// Each tab starts from the same workbook, and every batch either sends is logged for the joiner.
function session(base: Context) {
    const batches: Op[][] = [];
    const a = tab(base);
    const b = tab(base);
    const send = (from: Tab, ops: Op[]) => {
        if (ops.length === 0) return;
        batches.push(ops);
        for (const to of [a, b]) if (to !== from) tabReceive(to, ops);
    };
    return {
        a,
        b,
        batches,
        edit: (t: Tab, recipe: (ctx: Context) => void, options?: Parameters<typeof tabEdit>[2]) =>
            send(t, tabEdit(t, recipe, options)),
        undo: (t: Tab) => send(t, tabUndo(t)),
        redo: (t: Tab) => send(t, tabRedo(t)),
        joiner: () => join(base, batches),
    };
}

// What a user sees of a sheet. A sheet restored from its stored cells keeps them as celldata until it is opened.
const cells = (s: Sheet) => (s.data ? dataToCelldata(s.data) : (s.celldata ?? []));
const view = (sheets: Sheet[]) =>
    sheets.map((s) => ({ id: s.id, name: s.name, order: s.order, cells: cells(s), merge: s.config?.merge ?? {} }));

function expectAgree(s: ReturnType<typeof session>) {
    expect(view(s.b.ctx.sheets)).toEqual(view(s.a.ctx.sheets));
    expect(view(s.joiner())).toEqual(view(s.a.ctx.sheets));
}

function cellAt(t: Tab, a1: string, id = ONE) {
    const [r, c] = at(a1);
    return t.ctx.sheets.find((x) => x.id === id)?.data?.[r]?.[c] ?? null;
}

const on = (id: string, recipe: (ctx: Context) => void) => (ctx: Context) => {
    changeSheet(ctx, id);
    recipe(ctx);
};
const typedAt = (a1: string, value: string, id = ONE) => on(id, typed(...at(a1), value));

const insertRows = (index: number, count: number, id = ONE) => {
    const op = { type: 'row', index, count, direction: 'lefttop', id } as const;
    return [(ctx: Context) => insertRowCol(ctx, op), { insertRowColOp: op }] as const;
};
const insertColumns = (index: number, count: number, id = ONE) => {
    const op = { type: 'column', index, count, direction: 'lefttop', id } as const;
    return [(ctx: Context) => insertRowCol(ctx, op), { insertRowColOp: op }] as const;
};
const deleteRows = (start: number, end: number, id = ONE) => {
    const op = { type: 'row', start, end, id } as const;
    return [(ctx: Context) => deleteRowCol(ctx, op), { deleteRowColOp: op }] as const;
};
const removeSheet = (id: string) => [(ctx: Context) => deleteSheet(ctx, id), { deleteSheetOp: { id } }] as const;

describe("undo after a peer's row, column or sheet change lands on your cell", () => {
    test("a peer's row insert above moves the undo with the cell", () => {
        const s = session(workbook({ B10: text('old') }));
        s.edit(s.a, typedAt('B10', 'new'));
        s.edit(s.b, ...insertRows(2, 2));
        s.undo(s.a);
        expect(cellAt(s.a, 'B12')?.v).toBe('old');
        expect(cellAt(s.a, 'B10')).toBeNull();
        expectAgree(s);
        s.redo(s.a);
        expect(cellAt(s.a, 'B12')?.v).toBe('new');
        expectAgree(s);
    });

    test("a peer's column insert to the left moves the undo with the cell", () => {
        const s = session(workbook({ B10: text('old') }));
        s.edit(s.a, typedAt('B10', 'new'));
        s.edit(s.b, ...insertColumns(1, 1));
        s.undo(s.a);
        expect(cellAt(s.a, 'C10')?.v).toBe('old');
        expect(cellAt(s.a, 'B10')).toBeNull();
        expectAgree(s);
    });

    test("a peer's row delete above moves the undo with the cell", () => {
        const s = session(workbook({ B10: text('old') }));
        s.edit(s.a, typedAt('B10', 'new'));
        s.edit(s.b, ...deleteRows(2, 3));
        s.undo(s.a);
        expect(cellAt(s.a, 'B8')?.v).toBe('old');
        expectAgree(s);
    });

    test("a peer's delete of an earlier sheet leaves the undo on your sheet", () => {
        const s = session(workbook({}, { A1: text('two') }, { A1: text('old') }));
        s.edit(s.a, typedAt('A1', 'new', THREE));
        s.edit(s.b, ...removeSheet(ONE));
        s.undo(s.a);
        expect(cellAt(s.a, 'A1', THREE)?.v).toBe('old');
        expect(cellAt(s.a, 'A1', TWO)?.v).toBe('two');
        expectAgree(s);
    });

    test('a peer deleting the row of your edit drops that undo, and the one before still works', () => {
        const s = session(workbook({ B3: text('first'), B10: text('second') }));
        s.edit(s.a, typedAt('B3', 'one'));
        s.edit(s.a, typedAt('B10', 'two'));
        s.edit(s.b, ...deleteRows(9, 9));
        s.undo(s.a);
        s.undo(s.a);
        expect(cellAt(s.a, 'B3')?.v).toBe('first');
        expect(view(s.a.ctx.sheets)[0].cells.map((c) => c.v?.v)).toEqual(['first']);
        expectAgree(s);
    });

    // Your entries below your own row op were recorded without it. A peer's row op on its sheet drops that op's
    // entry, so they take the op's move first.
    test("a peer's row op that drops your row insert leaves your older undo on its cells", () => {
        const old = (r: number) => text(`old${r}`);
        const s = session(workbook({ B10: old(10), B11: old(11), B12: old(12), B13: old(13), B14: old(14) }));
        s.edit(s.a, (ctx) => {
            for (let r = 9; r <= 13; r += 1) typedAt(`B${r + 1}`, 'x')(ctx);
        });
        s.edit(s.a, ...insertRows(2, 2));
        s.edit(s.b, ...insertRows(0, 1));
        expect(s.a.history.undoList).toHaveLength(1);
        s.undo(s.a);
        expect([13, 14, 15, 16, 17].map((r) => cellAt(s.a, `B${r}`)?.v)).toEqual([
            'old10',
            'old11',
            'old12',
            'old13',
            'old14',
        ]);
        expectAgree(s);
    });

    test("a peer's row op that drops your undone row insert leaves your later redo on its cells", () => {
        const old = (r: number) => text(`old${r}`);
        const s = session(workbook({ B8: old(8), B9: old(9), B10: old(10), B11: old(11), B12: old(12) }));
        s.edit(s.a, ...insertRows(2, 2));
        s.edit(s.a, (ctx) => {
            for (let r = 9; r <= 13; r += 1) typedAt(`B${r + 1}`, 'x')(ctx);
        });
        s.undo(s.a);
        s.undo(s.a);
        s.edit(s.b, ...insertRows(0, 1));
        expect(s.a.history.redoList).toHaveLength(1);
        s.redo(s.a);
        expect([9, 10, 11, 12, 13].map((r) => cellAt(s.a, `B${r}`)?.v)).toEqual(['x', 'x', 'x', 'x', 'x']);
        expect(cellAt(s.a, 'B14')).toBeNull();
        expectAgree(s);
    });

    test("a peer's later value survives your undo", () => {
        const s = session(workbook({ B10: text('old') }));
        s.edit(s.a, typedAt('B10', 'new'));
        s.edit(s.b, typedAt('B10', 'peer'));
        s.undo(s.a);
        expect(cellAt(s.a, 'B10')?.v).toBe('peer');
        expectAgree(s);
    });

    test('alone: edit the third sheet, delete the second, undo twice', () => {
        const s = session(workbook({}, { A1: text('two') }, { C5: text('old') }));
        s.edit(s.a, typedAt('C5', 'new', THREE));
        s.edit(s.a, ...removeSheet(TWO));
        s.undo(s.a);
        s.undo(s.a);
        expect(cellAt(s.a, 'C5', THREE)?.v).toBe('old');
        expect(view(s.a.ctx.sheets).map((x) => x.id)).toEqual([ONE, THREE, TWO]);
        expect(view(s.a.ctx.sheets)[2].cells).toEqual([{ r: 0, c: 0, v: text('two') }]);
        expectAgree(s);
    });

    // Overwriting a formula rewrites the whole recalc list, so the entry holds every formula cell's place, also one in
    // rows the peer deletes.
    test("a peer's row delete keeps the undo of an edit that rewrote the whole recalc list", () => {
        const s = session(workbook({ A1: num(1), C2: { f: '=A1', v: 1, m: '1' }, B10: { f: '=A1', v: 1, m: '1' } }));
        s.edit(s.a, typedAt('C2', '5'));
        s.edit(s.b, ...deleteRows(9, 9));
        expect(s.a.history.undoList).toHaveLength(1);
        s.undo(s.a);
        expect(cellAt(s.a, 'C2')).toMatchObject({ f: '=A1', v: 1 });
        expect(s.a.ctx.sheets[0].calcChain).toContainEqual({ r: 1, c: 2, id: ONE });
        expectAgree(s);
    });

    test('a formula on another sheet that points at the moved rows undoes to its moved text', () => {
        const s = session(workbook({ B9: { v: 1, m: '1' }, B10: { v: 2, m: '2' } }, { A1: { f: '=One!B9', v: 1 } }));
        s.edit(s.a, typedAt('A1', '=One!B10', TWO));
        s.edit(s.b, ...insertRows(2, 2));
        expect(cellAt(s.a, 'A1', TWO)?.f).toBe('=One!B12');
        s.undo(s.a);
        expect(cellAt(s.a, 'A1', TWO)?.f).toBe('=One!B11');
        expectAgree(s);
    });
});

// A peer's batch moves this tab's undos only by what it did: nothing when it was skipped or its row op refused, and
// against the sheets it was applied to.
describe("a peer's batch shifts the undo stacks once it applied", () => {
    const peerInsert = (ops: Op[] = []): Op[] => [
        { op: 'insertRowCol', id: ONE, path: [], value: { type: 'row', index: 2, count: 2, direction: 'lefttop' } },
        ...ops,
    ];

    test('a batch that fails leaves the undo where it was', () => {
        const s = session(workbook({ B10: text('old') }));
        s.edit(s.a, typedAt('B10', 'new'));
        tabReceive(s.a, peerInsert([{ op: 'replace', id: ONE, path: ['data', 999, 999, 'v'], value: 1 }]));
        expect(cellAt(s.a, 'B10')?.v).toBe('new');
        tabUndo(s.a);
        expect(cellAt(s.a, 'B10')?.v).toBe('old');
    });

    test('a row op the sheet refuses leaves the undo where it was', () => {
        const s = session(workbook({ B10: text('old') }));
        s.edit(s.a, typedAt('B10', 'new'));
        s.a.ctx = produce(s.a.ctx, (ctx: Context) => {
            ctx.sheets[0].config = { ...ctx.sheets[0].config, rowReadOnly: { 2: 1 } };
        });
        tabReceive(s.a, peerInsert());
        expect(cellAt(s.a, 'B10')?.v).toBe('new');
        tabUndo(s.a);
        expect(cellAt(s.a, 'B10')?.v).toBe('old');
    });

    test('a second batch before the next render shifts against the sheets the first one added', () => {
        const base = workbook({}, { A1: text('old') });
        const a = tab(base);
        const b = tab(base);
        const settings = { ...defaultSettings, generateSheetId: () => 's4' };
        const added = tabEdit(b, (ctx) => addSheet(ctx, settings), { addSheetOp: true });
        const name = b.ctx.sheets[3].name;
        tabEdit(a, typedAt('A1', `=${name}!B10`, TWO));
        const inserted = tabEdit(b, ...insertRows(2, 2, 's4'));
        // One API, built on A's last render, takes both batches, as the Workbook's does between two renders.
        let next = a.ctx;
        const setContext = (recipe: (ctx: Context) => void) => {
            next = produce(next, recipe);
        };
        const api = generateAPIs(
            a.ctx,
            setContext,
            () => {},
            () => {},
            a.history,
        );
        api.applyOp(added);
        api.applyOp(inserted);
        a.ctx = next;
        expect(cellAt(a, 'A1', TWO)?.f).toBe(`=${name}!B12`);
        tabUndo(a);
        expect(cellAt(a, 'A1', TWO)?.v).toBe('old');
    });
});

describe("undo after a peer's row op on another sheet keeps formulas pointing at the moved rows", () => {
    test('a row delete brings back a formula with its reference moved', () => {
        const s = session(workbook({ A5: { f: '=Two!A10', v: 0, m: '0' } }));
        s.edit(s.a, ...deleteRows(4, 4));
        s.edit(s.b, ...insertRows(2, 2, TWO));
        s.undo(s.a);
        expect(cellAt(s.a, 'A5')?.f).toBe('=Two!A12');
        expectAgree(s);
    });

    test('a sheet delete brings back a formula with its reference moved', () => {
        const s = session(workbook({}, { A1: { f: '=One!A10', v: 0, m: '0' } }));
        s.edit(s.a, ...removeSheet(TWO));
        s.edit(s.b, ...insertRows(2, 2));
        s.undo(s.a);
        expect(view(s.a.ctx.sheets)[2].cells[0].v?.f).toBe('=One!A12');
        expectAgree(s);
    });

    test('a redone copy brings back its formula with its reference moved', () => {
        const s = session(workbook({}, { A1: { f: '=One!A10', v: 0, m: '0' } }));
        s.edit(s.a, (ctx) => copySheet(ctx, TWO), { addSheetOp: true });
        s.undo(s.a);
        s.edit(s.b, ...insertRows(2, 2));
        s.redo(s.a);
        expect(cells(s.a.ctx.sheets[3])[0].v?.f).toBe('=One!A12');
        expectAgree(s);
    });

    test("your row insert stays undoable after a peer's row insert on a sheet whose formulas it moved", () => {
        const s = session(workbook({ A10: { v: 1, m: '1' } }, { A5: { f: '=One!A10', v: 1, m: '1' } }));
        s.edit(s.a, ...insertRows(2, 1));
        expect(cellAt(s.a, 'A5', TWO)?.f).toBe('=One!A11');
        s.edit(s.b, ...insertRows(0, 2, TWO));
        s.undo(s.a);
        expect(cellAt(s.a, 'A10')?.v).toBe(1);
        expect(cellAt(s.a, 'A7', TWO)?.f).toBe('=One!A10');
        expectAgree(s);
    });

    test("a sheet's first link stays undoable after a peer's row insert", () => {
        const s = session(workbook({ B5: text('link') }));
        s.edit(s.a, (ctx) => saveHyperlink(ctx, 4, 1, 'link', 'webpage', 'https://eigen.is'));
        s.edit(s.b, ...insertRows(2, 2));
        s.undo(s.a);
        expect(s.a.ctx.sheets[0].hyperlink ?? {}).toEqual({});
        expectAgree(s);
    });
});

// Enter commits where the open editor stands, so a peer's row or column op moves it with its cell.
describe("an open cell editor follows a peer's row or column op", () => {
    const open = (t: Tab, a1: string) => {
        t.ctx = produce(t.ctx, (ctx: Context) => {
            ctx.editingCellPosition = at(a1);
        });
    };
    const commit = (ctx: Context) => {
        const [r, c] = ctx.editingCellPosition;
        typed(r, c, 'mine')(ctx);
    };

    test("a peer's row insert above moves it, and the commit keeps the peer's cell", () => {
        const s = session(workbook({ B8: text('peer'), B10: text('old') }));
        open(s.a, 'B10');
        s.edit(s.b, ...insertRows(2, 2));
        expect(s.a.ctx.editingCellPosition).toEqual(at('B12'));
        s.edit(s.a, commit);
        expect(cellAt(s.a, 'B10')?.v).toBe('peer');
        expect(cellAt(s.a, 'B12')?.v).toBe('mine');
        expectAgree(s);
    });

    test("a peer's row delete above moves it up", () => {
        const s = session(workbook({ B10: text('old') }));
        open(s.a, 'B10');
        s.edit(s.b, ...deleteRows(2, 3));
        expect(s.a.ctx.editingCellPosition).toEqual(at('B8'));
    });

    test("a peer's column insert to the left moves it right", () => {
        const s = session(workbook({ B10: text('old') }));
        open(s.a, 'B10');
        s.edit(s.b, ...insertColumns(0, 1));
        expect(s.a.ctx.editingCellPosition).toEqual(at('C10'));
    });

    test("a peer's delete of its row closes it", () => {
        const s = session(workbook({ B10: text('old') }));
        open(s.a, 'B10');
        s.edit(s.b, ...deleteRows(9, 9));
        expect(s.a.ctx.editingCellPosition).toEqual([]);
    });

    test("a peer's row op on another sheet leaves it", () => {
        const s = session(workbook({ B10: text('old') }));
        open(s.a, 'B10');
        s.edit(s.b, ...insertRows(2, 2, TWO));
        expect(s.a.ctx.editingCellPosition).toEqual(at('B10'));
    });
});

// A joiner and the server read the stored cells of every sheet a batch doesn't name, so a row op must move the
// formulas there as the live tabs move them in their matrices.
describe("a row op moves another sheet's formulas for every reader", () => {
    const pointing = () =>
        workbook({ B10: text('x') }, { A1: { f: '=One!B10', v: 'x' }, A2: { f: '=SUM(One!B1:B20)', v: 0 } });

    test('a row delete moves them on both tabs and for a joiner', () => {
        const s = session(pointing());
        s.edit(s.b, ...deleteRows(2, 3));
        expect(cellAt(s.a, 'A1', TWO)?.f).toBe('=One!B8');
        expect(cellAt(s.a, 'A2', TWO)?.f).toBe('=SUM(One!B1:B18)');
        expectAgree(s);
    });

    test('a row insert moves them in a copy nobody opened', () => {
        const s = session(pointing());
        s.edit(s.a, (ctx) => copySheet(ctx, TWO), { addSheetOp: true });
        s.edit(s.b, ...insertRows(2, 2));
        expect(cells(s.a.ctx.sheets[3])[0].v?.f).toBe('=One!B12');
        expectAgree(s);
    });
});

test("an edit to a linked cell after a peer's row insert keeps its link everywhere", () => {
    const s = session(workbook({ B5: text('link') }));
    s.edit(s.a, (ctx) => saveHyperlink(ctx, 4, 1, 'link', 'webpage', 'https://eigen.is'));
    s.edit(s.b, ...insertRows(2, 2));
    s.edit(s.a, (ctx) => {
        const row = ctx.sheets[0].data?.[6];
        if (row) row[1] = { ...row[1], bl: 1 };
    });
    expect(s.a.ctx.sheets[0].hyperlink).toStrictEqual({
        '6_1': { linkType: 'webpage', linkAddress: 'https://eigen.is' },
    });
    expect(s.b.ctx.sheets[0].hyperlink).toStrictEqual(s.a.ctx.sheets[0].hyperlink);
});

describe('undo skips a cell a peer changed since, by what was written into it', () => {
    test('a formula whose precedent a peer changed still undoes', () => {
        const s = session(workbook({ A1: { v: 5, m: '5' }, B1: { f: '=A1*3', v: 15, m: '15' } }));
        s.edit(s.a, typedAt('B1', '=A1*2'));
        s.edit(s.b, typedAt('A1', '7'));
        expect(cellAt(s.a, 'B1')?.v).toBe(14);
        s.undo(s.a);
        expect(cellAt(s.a, 'B1')?.f).toBe('=A1*3');
        expectAgree(s);
    });

    test('a merge whose cell a peer changed skips whole', () => {
        const s = session(workbook({ A1: text('a') }));
        const range = [{ row: [0, 1], column: [0, 1] }];
        s.edit(s.a, (ctx) => mergeCells(ctx, ONE, range, 'merge-all'));
        s.edit(s.b, typedAt('A1', 'peer'));
        s.undo(s.a);
        expect(s.a.ctx.sheets[0].config?.merge).toEqual({ '0_0': { r: 0, c: 0, rs: 2, cs: 2 } });
        expect(cellAt(s.a, 'B2')?.mc).toEqual({ r: 0, c: 0 });
        expectAgree(s);
    });
});

// An undo sends what a person wrote and recalculates the rest: a value the engine computed is only right for the
// inputs at the time it was recorded.
describe('undo and redo recalculate the formulas they touch', () => {
    test("a dependent reads a peer's later input after your undo", () => {
        const s = session(workbook({ A1: num(1), B1: num(2), D10: { f: '=A1+B1', v: 3, m: '3' } }));
        s.edit(s.a, typedAt('A1', '5'));
        s.edit(s.b, typedAt('B1', '100'));
        expect(cellAt(s.b, 'D10')?.v).toBe(105);
        s.undo(s.a);
        for (const t of [s.a, s.b]) expect(cellAt(t, 'D10')?.v).toBe(101);
        // The batch carries the recalculated value alone, never the one the entry recorded.
        const sent = s.batches.at(-1)?.filter(({ path }) => path[1] === 9 && path[2] === 3 && path[3] === 'v');
        expect(sent?.map((op) => op.value)).toEqual([101]);
        expect(s.joiner()[0].data?.[9]?.[3]?.v).toBe(101);
        expectAgree(s);
        s.redo(s.a);
        for (const t of [s.a, s.b]) expect(cellAt(t, 'D10')?.v).toBe(105);
        expectAgree(s);
    });

    test('a formula a peer rewrote keeps a value that matches it after your undo', () => {
        const s = session(workbook({ A1: num(1), D10: { f: '=A1*2', v: 2, m: '2' } }));
        s.edit(s.a, typedAt('A1', '5'));
        s.edit(s.b, typedAt('D10', '=A1*3'));
        s.undo(s.a);
        for (const t of [s.a, s.b]) expect(cellAt(t, 'D10')).toMatchObject({ f: '=A1*3', v: 3 });
        expectAgree(s);
    });

    test("an undone formula computes from a peer's later input", () => {
        const s = session(workbook({ A1: num(5), B1: { f: '=A1*3', v: 15, m: '15' } }));
        s.edit(s.a, typedAt('B1', '=A1*2'));
        s.edit(s.b, typedAt('A1', '7'));
        s.undo(s.a);
        for (const t of [s.a, s.b]) expect(cellAt(t, 'B1')).toMatchObject({ f: '=A1*3', v: 21 });
        expectAgree(s);
    });
});

test("a redone formula stays in the recalc list at its place after a peer's row insert", () => {
    const s = session(workbook({ A1: { v: 1, m: '1', ct: { fa: 'General', t: 'n' } } }));
    s.edit(s.a, typedAt('D10', '=A1*2'));
    s.edit(s.b, ...insertRows(2, 2));
    s.undo(s.a);
    s.redo(s.a);
    for (const t of [s.a, s.b]) expect(t.ctx.sheets[0].calcChain).toEqual([{ r: 11, c: 3, id: ONE }]);
    s.edit(s.b, typedAt('A1', '7'));
    for (const t of [s.a, s.b]) expect(cellAt(t, 'D12')?.v).toBe(14);
    expectAgree(s);
});

describe('a structural undo or redo applies exactly what it sends', () => {
    test("undoing your row insert keeps a peer's edit below it", () => {
        const s = session(workbook());
        s.edit(s.a, ...insertRows(4, 1));
        s.edit(s.b, typedAt('D20', 'peer'));
        s.undo(s.a);
        expect(cellAt(s.a, 'D19')?.v).toBe('peer');
        expectAgree(s);
    });

    const sums = () =>
        workbook(
            {
                A4: { v: 1, m: '1' },
                A5: { v: 2, m: '2' },
                A6: { v: 3, m: '3' },
                A8: { v: 4, m: '4' },
                B1: { f: '=SUM(A4:A8)', v: 10, m: '10' },
                C1: { f: '=A5', v: 2, m: '2' },
            },
            { A1: { f: '=SUM(One!A4:A8)', v: 10, m: '10' }, A2: { f: '=One!A6', v: 3, m: '3' } },
        );

    test("undoing your row delete brings the cells and formulas back and keeps a peer's edit", () => {
        const base = sums();
        const s = session(base);
        s.edit(s.a, ...deleteRows(4, 5));
        expect(cellAt(s.a, 'C1')?.f).toContain('#REF!');
        s.edit(s.b, typedAt('F30', 'peer'));
        s.undo(s.a);
        for (const a1 of ['A4', 'A5', 'A6', 'A8', 'B1', 'C1']) expect(cellAt(s.a, a1)).toEqual(cellAt(tab(base), a1));
        for (const a1 of ['A1', 'A2']) expect(cellAt(s.a, a1, TWO)).toEqual(cellAt(tab(base), a1, TWO));
        expect(cellAt(s.a, 'F32')?.v).toBe('peer');
        expectAgree(s);
        s.redo(s.a);
        expect(cellAt(s.a, 'F30')?.v).toBe('peer');
        expect(cellAt(s.a, 'A6')?.v).toBe(4);
        expectAgree(s);
    });

    test('a formula a peer rewrote after your row delete keeps the peer’s text when you undo', () => {
        const s = session(sums());
        s.edit(s.a, ...deleteRows(4, 5));
        s.edit(s.b, typedAt('C1', '=A4'));
        s.undo(s.a);
        expect(cellAt(s.a, 'C1')?.f).toBe('=A4');
        expectAgree(s);
    });

    // The step ships the sheet's fields whole, so they must be the live ones with the marker applied, not the ones the
    // entry recorded at the op.
    test("undoing your row insert keeps a peer's later column width", () => {
        const s = session(workbook());
        s.edit(s.a, ...insertRows(4, 1));
        s.edit(s.b, (ctx) => setColumnWidth(ctx, { 2: 250 }, { id: ONE }));
        s.undo(s.a);
        for (const sheets of [s.a.ctx.sheets, s.b.ctx.sheets, s.joiner()]) {
            expect(sheets[0].config?.columnlen).toEqual({ 2: 250 });
        }
    });

    test("undoing your row insert keeps a peer's later merge, and the joiner agrees on its cells", () => {
        const s = session(workbook({ A1: text('x') }));
        s.edit(s.a, ...insertRows(4, 1));
        s.edit(
            s.b,
            on(ONE, (ctx) => mergeCells(ctx, ONE, [{ row: [20, 21], column: [0, 1] }], 'merge-all')),
        );
        s.undo(s.a);
        expect(s.a.ctx.sheets[0].config?.merge).toEqual({ '19_0': { r: 19, c: 0, rs: 2, cs: 2 } });
        expect(cellAt(s.a, 'B21')?.mc).toEqual({ r: 19, c: 0 });
        expectAgree(s);
    });

    test("undoing your row delete keeps a peer's later formula recalculating", () => {
        const s = session(workbook({ A1: { v: 1, m: '1', ct: { fa: 'General', t: 'n' } }, A5: text('gone') }));
        s.edit(s.a, ...deleteRows(4, 5));
        s.edit(s.b, typedAt('D20', '=A1*2'));
        s.undo(s.a);
        for (const t of [s.a, s.b]) expect(t.ctx.sheets[0].calcChain).toContainEqual({ r: 21, c: 3, id: ONE });
        s.edit(s.b, typedAt('A1', '7'));
        for (const t of [s.a, s.b]) expect(cellAt(t, 'D22')?.v).toBe(14);
        expectAgree(s);
    });

    test("undoing your row delete brings back the deleted rows' height and link, and keeps a peer's later width", () => {
        const base = produce(workbook({ B5: text('link') }), (ctx: Context) => {
            ctx.sheets[0].config = { ...ctx.sheets[0].config, rowlen: { 4: 40 } };
            ctx.sheets[0].hyperlink = { '4_1': { linkType: 'webpage', linkAddress: 'https://eigen.is' } };
        });
        const s = session(base);
        s.edit(s.a, ...deleteRows(4, 5));
        s.edit(s.b, (ctx) => setColumnWidth(ctx, { 2: 250 }, { id: ONE }));
        s.undo(s.a);
        for (const sheets of [s.a.ctx.sheets, s.b.ctx.sheets, s.joiner()]) {
            expect(sheets[0].config?.rowlen).toEqual({ 4: 40 });
            expect(sheets[0].config?.columnlen).toEqual({ 2: 250 });
            expect(sheets[0].hyperlink).toEqual(base.sheets[0].hyperlink);
        }
        expectAgree(s);
    });

    test('undoing a delete of merged rows brings the merge back everywhere', () => {
        const merge = { r: 4, c: 0, rs: 2, cs: 2 };
        const corner = { mc: { r: 4, c: 0 } };
        const base = produce(
            workbook({ A5: { v: 'm', m: 'm', mc: merge }, B5: corner, A6: corner, B6: corner }),
            (ctx: Context) => {
                ctx.sheets[0].config = { ...ctx.sheets[0].config, merge: { '4_0': merge } };
            },
        );
        const s = session(base);
        s.edit(s.a, ...deleteRows(4, 5));
        s.undo(s.a);
        expect(s.a.ctx.sheets[0].config?.merge).toEqual({ '4_0': merge });
        expect(cellAt(s.a, 'B6')?.mc).toEqual({ r: 4, c: 0 });
        expectAgree(s);
    });

    test('undoing a row delete while another sheet is current restores the sheet it was made on', () => {
        const base = sums();
        const s = session(base);
        s.edit(s.a, ...deleteRows(4, 5));
        s.a.ctx = produce(s.a.ctx, (ctx: Context) => changeSheet(ctx, TWO));
        s.undo(s.a);
        for (const a1 of ['A4', 'A5', 'A6', 'A8']) expect(cellAt(s.a, a1)).toEqual(cellAt(tab(base), a1));
        expectAgree(s);
    });

    test("redoing a sheet delete keeps a peer's edit on another sheet", () => {
        const s = session(workbook({}, { A1: text('two') }));
        s.edit(s.a, ...removeSheet(TWO));
        s.undo(s.a);
        s.edit(s.b, typedAt('A1', 'peer', THREE));
        s.redo(s.a);
        expect(cellAt(s.a, 'A1', THREE)?.v).toBe('peer');
        expect(view(s.a.ctx.sheets).map((x) => x.id)).toEqual([ONE, THREE]);
        expectAgree(s);
    });

    test("undoing a redone sheet delete brings the sheet back with a peer's edit made before the redo", () => {
        const s = session(workbook({}, { A1: text('two') }));
        s.edit(s.a, ...removeSheet(TWO));
        s.undo(s.a);
        s.edit(s.b, typedAt('B2', 'peer', TWO));
        s.redo(s.a);
        s.undo(s.a);
        expect(view(s.a.ctx.sheets)[2].cells).toEqual([
            { r: 0, c: 0, v: text('two') },
            { r: 1, c: 1, v: text('peer') },
        ]);
        expectAgree(s);
    });

    test('redoing a sheet delete a peer already made leaves the sheet deleted after your next undo', () => {
        const s = session(workbook({}, { A1: text('two') }));
        s.edit(s.a, ...removeSheet(TWO));
        s.undo(s.a);
        s.edit(s.b, typedAt('B2', 'peer', TWO));
        s.edit(s.b, ...removeSheet(TWO));
        s.redo(s.a);
        s.undo(s.a);
        for (const sheets of [s.a.ctx.sheets, s.b.ctx.sheets, s.joiner()]) {
            expect(view(sheets).map((x) => x.id)).toEqual([ONE, THREE]);
        }
        expectAgree(s);
    });

    test("a peer's edit to a sheet you restored applies on your side", () => {
        const s = session(workbook({}, { A1: text('two') }));
        s.edit(s.a, ...removeSheet(TWO));
        s.undo(s.a);
        s.edit(s.b, typedAt('B2', 'peer', TWO));
        expect(cellAt(s.a, 'B2', TWO)?.v).toBe('peer');
        expectAgree(s);
    });

    // A copy keeps its cells as celldata until someone opens it.
    test('undoing the delete of a copy nobody opened brings back its cells', () => {
        const s = session(workbook({}, { A1: text('two') }));
        s.edit(s.a, (ctx) => copySheet(ctx, TWO), { addSheetOp: true });
        const copy = s.a.ctx.sheets[3];
        expect(copy.data).toBeUndefined();
        s.edit(s.a, ...removeSheet(String(copy.id)));
        s.undo(s.a);
        expect(view(s.a.ctx.sheets)[3].cells).toEqual([{ r: 0, c: 0, v: text('two') }]);
        expectAgree(s);
    });

    test("a peer's edit to a copy you never opened applies on your side", () => {
        const s = session(workbook({}, { A1: text('two') }));
        s.edit(s.a, (ctx) => copySheet(ctx, TWO), { addSheetOp: true });
        const copy = String(s.a.ctx.sheets[3].id);
        s.edit(s.b, typedAt('B2', 'peer', copy));
        expect(cellAt(s.a, 'B2', copy)?.v).toBe('peer');
        expectAgree(s);
    });

    // The Workbook builds a sheet delete's batch from the options recordEntry returns, so the deleted sheet reaches it
    // by value, not through a write into the options it passed in.
    test("a sheet delete's batch comes from the options its entry returns", () => {
        const options = { deleteSheetOp: { id: TWO } };
        const { ops, entry } = author(workbook(), (ctx) => deleteSheet(ctx, TWO), options);
        expect(options).toEqual({ deleteSheetOp: { id: TWO } });
        expect(entry.options?.deletedSheet?.id).toBe(TWO);
        expect(ops[0]).toEqual({ op: 'deleteSheet', id: TWO, path: [], value: { id: TWO } });
    });

    test('undoing a sheet add removes it everywhere, and redo brings it back', () => {
        const s = session(workbook());
        const settings = { ...defaultSettings, generateSheetId: () => 's4' };
        s.edit(s.a, (ctx) => addSheet(ctx, settings), { addSheetOp: true });
        expect(view(s.b.ctx.sheets).map((x) => x.id)).toEqual([ONE, TWO, THREE, 's4']);
        s.undo(s.a);
        expect(view(s.a.ctx.sheets).map((x) => x.id)).toEqual([ONE, TWO, THREE]);
        expectAgree(s);
        s.redo(s.a);
        expect(view(s.a.ctx.sheets).map((x) => x.id)).toEqual([ONE, TWO, THREE, 's4']);
        expectAgree(s);
    });
});

// A row, column or sheet entry holds whole cell matrices, so the stack keeps fewer of those than of the rest.
describe('the undo stack keeps the newest entries', () => {
    test('the newest 200', () => {
        const t = tab(workbook());
        for (let i = 0; i < 205; i += 1) tabEdit(t, typedAt('A1', `v${i}`));
        expect(t.history.undoList).toHaveLength(200);
        tabUndo(t);
        expect(cellAt(t, 'A1')?.v).toBe('v203');
    });

    test('the newest ten that hold whole matrices, and every entry after the oldest of them', () => {
        const t = tab(workbook());
        tabEdit(t, typedAt('A1', 'x'));
        for (let i = 0; i < 12; i += 1) tabEdit(t, ...insertRows(30, 1));
        tabEdit(t, typedAt('A1', 'y'));
        expect(t.history.undoList).toHaveLength(11);
        expect(t.history.undoList.filter((entry) => entry.options?.insertRowColOp)).toHaveLength(10);
    });
});

// The shifter's own table: one patch of an entry through a peer's marker on One, and what it becomes, or null when the
// entry is dropped. It pins paths and values, which the cases above only see through what a user sees.
describe('shiftEntries', () => {
    const rows = (index: number, count: number): Op => ({
        op: 'insertRowCol',
        id: ONE,
        path: [],
        value: { type: 'row', index, count, direction: 'lefttop' },
    });
    const deletedRows = (start: number, end: number): Op => ({
        op: 'deleteRowCol',
        id: ONE,
        path: [],
        value: { type: 'row', start, end },
    });
    const columns = (index: number, count: number): Op => ({
        ...rows(index, count),
        value: { ...rows(index, count).value, type: 'column' },
    });
    const onOne = {
        ...newSheetChartSpecParts({
            ...sampleChartSpec('column'),
            series: { 's-1': { ...DEFAULT_CHART_SERIES_STYLE, color: '#2a78d6' } },
            data: {
                source: 'range',
                categories: null,
                series: [{ id: 's-1', name: 'Points', values: { sheetId: ONE, row: [2, 5], column: [1, 1] } }],
            },
        }),
        id: 'c1',
        index: 'a0',
        x: 0,
        y: 0,
        width: 100,
        height: 100,
    };
    const sheets: Sheet[] = [
        { ...sheet(ONE, 'One', 0), charts: { c1: onOne } },
        { ...sheet(TWO, 'Two', 1), charts: { c2: { ...onOne, id: 'c2' } } },
    ];
    const replace = (path: Patch['path'], value?: unknown): Patch => ({ op: 'replace', path, value });
    const at = (...path: Patch['path']) => ['sheets', ONE, ...path];

    test.each<[string, Op, Patch, Patch | null]>([
        [
            'a cell below the insert moves down',
            rows(2, 2),
            replace(at('data', 5, 1), { v: 1 }),
            replace(at('data', 7, 1), { v: 1 }),
        ],
        ['a cell above it stays', rows(2, 2), replace(at('data', 1, 1), { v: 1 }), replace(at('data', 1, 1), { v: 1 })],
        [
            'its formula moves',
            rows(2, 2),
            replace(at('data', 5, 1), { f: '=B6' }),
            replace(at('data', 7, 1), { f: '=B8' }),
        ],
        [
            'a formula field moves',
            rows(2, 2),
            replace(at('data', 5, 1, 'f'), '=A6'),
            replace(at('data', 7, 1, 'f'), '=A8'),
        ],
        [
            'a merge corner moves',
            rows(2, 2),
            replace(at('data', 5, 1), { mc: { r: 5, c: 1, rs: 2, cs: 2 } }),
            replace(at('data', 7, 1), { mc: { r: 7, c: 1, rs: 2, cs: 2 } }),
        ],
        [
            'a merge it cuts drops the entry',
            rows(2, 2),
            replace(at('data', 1, 0), { mc: { r: 1, c: 0, rs: 3, cs: 1 } }),
            null,
        ],
        [
            'a formula on another sheet moves its reference to One',
            rows(2, 2),
            replace(['sheets', TWO, 'data', 0, 0], { f: '=One!A6+A6' }),
            replace(['sheets', TWO, 'data', 0, 0], { f: '=One!A8+A6' }),
        ],
        [
            'a merge entry moves',
            rows(2, 2),
            replace(at('config', 'merge', '5_1'), { r: 5, c: 1, rs: 2, cs: 2 }),
            replace(at('config', 'merge', '7_1'), { r: 7, c: 1, rs: 2, cs: 2 }),
        ],
        [
            'a merge entry it cuts drops the entry',
            rows(2, 2),
            replace(at('config', 'merge', '1_0'), { r: 1, c: 0, rs: 3, cs: 1 }),
            null,
        ],
        [
            'a border moves',
            rows(2, 2),
            replace(at('config', 'borderInfo', '5_1', 't'), 1),
            replace(at('config', 'borderInfo', '7_1', 't'), 1),
        ],
        [
            'a row height moves',
            rows(2, 2),
            replace(at('config', 'rowlen', '5'), 30),
            replace(at('config', 'rowlen', '7'), 30),
        ],
        [
            'a column width stays',
            rows(2, 2),
            replace(at('config', 'columnlen', '5'), 30),
            replace(at('config', 'columnlen', '5'), 30),
        ],
        [
            'a column width moves with a column insert',
            columns(2, 2),
            replace(at('config', 'columnlen', '5'), 30),
            replace(at('config', 'columnlen', '7'), 30),
        ],
        [
            'a link moves',
            rows(2, 2),
            replace(at('hyperlink', '5_1'), { linkType: 'webpage' }),
            replace(at('hyperlink', '7_1'), { linkType: 'webpage' }),
        ],
        [
            'a validation rule moves',
            rows(2, 2),
            replace(at('dataVerification', '5_1'), { type: 'checkbox' }),
            replace(at('dataVerification', '7_1'), { type: 'checkbox' }),
        ],
        [
            'a cell below a delete moves up',
            deletedRows(2, 3),
            replace(at('data', 5, 1), { v: 1 }),
            replace(at('data', 3, 1), { v: 1 }),
        ],
        ['a cell inside a delete drops the entry', deletedRows(2, 3), replace(at('data', 3, 1), { v: 1 }), null],
        [
            'a row height inside a delete drops the entry',
            deletedRows(2, 3),
            replace(at('config', 'rowlen', '2'), 30),
            null,
        ],
        ['a whole config drops the entry', rows(2, 2), replace(at('config'), {}), null],
        [
            'a whole matrix moves with the rows',
            rows(1, 1),
            replace(at('data'), [[{ v: 1 }], [null], [{ f: '=A2' }]]),
            replace(at('data'), [[{ v: 1 }], [null], [null], [{ f: '=A3' }]]),
        ],
        [
            'a whole matrix on another sheet moves its formulas that read One',
            rows(1, 1),
            replace(['sheets', TWO, 'data'], [[{ f: '=One!A2+A2' }]]),
            replace(['sheets', TWO, 'data'], [[{ f: '=One!A3+A2' }]]),
        ],
        [
            'a whole row moves with a row insert',
            rows(2, 2),
            replace(at('data', 5), [{ v: 1 }]),
            replace(at('data', 7), [{ v: 1 }]),
        ],
        [
            "a sheet's whole link map moves",
            rows(2, 2),
            replace(at('hyperlink'), { '5_1': { linkType: 'webpage' } }),
            replace(at('hyperlink'), { '7_1': { linkType: 'webpage' } }),
        ],
        [
            'a whole link map that loses a link to a delete drops the entry',
            deletedRows(2, 3),
            replace(at('hyperlink'), { '3_1': { linkType: 'webpage' } }),
            null,
        ],
        [
            'a whole row height map moves',
            rows(2, 2),
            replace(at('config', 'rowlen'), { 5: 30 }),
            replace(at('config', 'rowlen'), { 7: 30 }),
        ],
        ['a conditional format drops the entry', rows(2, 2), replace(at('conditionalFormatRules', 0), {}), null],
        ['a whole row drops the entry on a column insert', columns(2, 2), replace(at('data', 5), []), null],
        ["a chart's data on One drops the entry", rows(2, 2), replace(at('charts', 'c1', 'specData'), '{}'), null],
        [
            'a chart on Two reading One drops the entry too',
            rows(2, 2),
            replace(['sheets', TWO, 'charts', 'c2', 'specData'], '{}'),
            null,
        ],
        ["a chart's box stays", rows(2, 2), replace(at('charts', 'c1', 'x'), 5), replace(at('charts', 'c1', 'x'), 5)],
        [
            'a recalc list entry moves with its cell',
            rows(2, 2),
            replace(at('calcChain', 0), { r: 5, c: 1, id: ONE }),
            replace(at('calcChain', 0), { r: 7, c: 1, id: ONE }),
        ],
        [
            'a whole recalc list moves',
            columns(0, 1),
            replace(at('calcChain'), [{ r: 5, c: 1, id: ONE }]),
            replace(at('calcChain'), [{ r: 5, c: 2, id: ONE }]),
        ],
        [
            'a whole recalc list loses the cells inside a delete',
            deletedRows(2, 3),
            replace(at('calcChain'), [
                { r: 1, c: 1, id: ONE },
                { r: 3, c: 1, id: ONE },
                { r: 5, c: 1, id: ONE },
            ]),
            replace(at('calcChain'), [
                { r: 1, c: 1, id: ONE },
                { r: 3, c: 1, id: ONE },
            ]),
        ],
        [
            'a recalc list entry inside a delete drops the entry',
            deletedRows(2, 3),
            replace(at('calcChain', 0), { r: 3, c: 1, id: ONE }),
            null,
        ],
        [
            "the recalc list's length stays",
            rows(2, 2),
            replace(at('calcChain', 'length'), 0),
            replace(at('calcChain', 'length'), 0),
        ],
        ['the name stays', rows(2, 2), replace(at('name'), 'Uno'), replace(at('name'), 'Uno')],
    ])('%s', (_, marker, patch, expected) => {
        const [shifted] = shiftEntries([{ patches: [patch], inversePatches: [] }], marker, sheets, 'undo');
        expect<Patch | null>(shifted?.patches[0] ?? null).toEqual(expected);
    });

    test('drops your own row or column entry on the same sheet, and keeps one on another', () => {
        const own = (id: string): History => ({
            patches: [],
            inversePatches: [],
            options: { insertRowColOp: { type: 'row', index: 0, count: 1, direction: 'lefttop', id } },
        });
        expect(shiftEntries([own(ONE), own(TWO)], rows(2, 2), sheets, 'undo')).toEqual([own(TWO)]);
    });

    test('returns an entry the marker does not touch as it is', () => {
        const entry: History = { patches: [replace(at('data', 1, 1), { v: 1 })], inversePatches: [] };
        expect(shiftEntries([entry], rows(2, 2), sheets, 'undo')[0]).toBe(entry);
    });
});
