// Undo and redo with a peer at work. Each case runs two tabs on one workbook, A and B, through the real record, applyOp
// and undo steps, and checks what a user sees: the cell the undo lands in, on A, on B and for a joiner who replays
// every batch. The three must always agree.

import { describe, expect, test } from 'bun:test';
import { DEFAULT_CHART_SERIES_STYLE, newSheetChartSpecParts, sampleChartSpec } from '@workspace/lib/charts';
import type { Patch } from 'immer';
import { produce } from 'immer';
import { dataToCelldata } from '../../../engine/celldata';
import { normalizeSheetConfig } from '../../../engine/sheet-config';
import type { Cell } from '../../../engine/types';
import { copySheet } from '../../../state/api/sheet';
import type { Context } from '../../../state/context';
import { shiftEntries } from '../../../state/modules/history';
import { mergeCells } from '../../../state/modules/merge';
import { deleteRowCol, insertRowCol } from '../../../state/modules/rowcol';
import { addSheet, changeSheet, deleteSheet } from '../../../state/modules/sheet';
import { defaultSettings } from '../../../state/settings';
import type { History, Op, Sheet } from '../../../state/types';
import type { Tab } from '../factories/collab';
import { join, tab, tabEdit, tabReceive, tabRedo, tabUndo } from '../factories/collab';
import { contextFactory } from '../factories/context';
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
    const ctx = contextFactory({
        currentSheetId: ONE,
        sheets: [sheet(ONE, 'One', 0, one), sheet(TWO, 'Two', 1, two), sheet(THREE, 'Three', 2, three)],
    }) as Context;
    for (const s of ctx.sheets) normalizeSheetConfig(s);
    return ctx;
}

const text = (v: string): Cell => ({ v, m: v, ct: { fa: 'General', t: 'g' } });

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

    test('undoing a delete of merged rows brings the merge back everywhere', () => {
        const merge = { r: 4, c: 0, rs: 2, cs: 2 };
        const base = produce(
            workbook({ A5: { v: 'm', m: 'm', mc: merge }, B5: { mc: { r: 4, c: 0 } } }),
            (ctx: Context) => {
                ctx.sheets[0].data![5][0] = { mc: { r: 4, c: 0 } };
                ctx.sheets[0].data![5][1] = { mc: { r: 4, c: 0 } };
                ctx.sheets[0].config!.merge = { '4_0': merge };
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
        s.edit(s.a, ...removeSheet(copy.id as string));
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
        ['a whole matrix drops the entry', rows(2, 2), replace(at('data'), []), null],
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
            'calcChain stays',
            rows(2, 2),
            replace(at('calcChain', 0), { r: 5, c: 1, id: ONE }),
            replace(at('calcChain', 0), { r: 5, c: 1, id: ONE }),
        ],
        ['the name stays', rows(2, 2), replace(at('name'), 'Uno'), replace(at('name'), 'Uno')],
    ])('%s', (_, marker, patch, expected) => {
        const [shifted] = shiftEntries([{ patches: [patch], inversePatches: [] }], marker, sheets);
        expect<Patch | null>(shifted?.patches[0] ?? null).toEqual(expected);
    });

    test('drops your own row or column entry on the same sheet, and keeps one on another', () => {
        const own = (id: string): History => ({
            patches: [],
            inversePatches: [],
            options: { insertRowColOp: { type: 'row', index: 0, count: 1, direction: 'lefttop', id } },
        });
        expect(shiftEntries([own(ONE), own(TWO)], rows(2, 2), sheets)).toEqual([own(TWO)]);
    });

    test('returns an entry the marker does not touch as it is', () => {
        const entry: History = { patches: [replace(at('data', 1, 1), { v: 1 })], inversePatches: [] };
        expect(shiftEntries([entry], rows(2, 2), sheets)[0]).toBe(entry);
    });
});
