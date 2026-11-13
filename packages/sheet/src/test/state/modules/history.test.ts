import { afterEach, describe, expect, mock, spyOn, test } from 'bun:test';
import { DEFAULT_CHART_SERIES_STYLE, newChartSpecParts, sampleChartSpec } from '@workspace/lib/charts';
import type { Sheet as LibSheet } from '@workspace/lib/sheets';
import type { ChartSpecChange } from '@workspace/lib/types/chart';
import type { Patch } from 'immer';
import { produce } from 'immer';
import { generateAPIs } from '../../../components/Workbook/api';
import { dataToCelldata } from '../../../engine/celldata';
import { MAX_SHEET_ROW_COUNT } from '../../../engine/defaults';
import { normalizeSheetConfig } from '../../../engine/sheet-config';
import type { Cell, ShiftedSheet } from '../../../engine/types';
import { getSheet } from '../../../state/api/common';
import { copySheet, hideSheet, showSheet } from '../../../state/api/sheet';
import type { Context } from '../../../state/context';
import { getFlowdata } from '../../../state/context';
import { setChartSpec } from '../../../state/modules/chart';
import { deleteSheetRule } from '../../../state/modules/condition-format';
import { applyDataValidation } from '../../../state/modules/data-validation';
import type { RowColMove } from '../../../state/modules/history-shift';
import { deleteMove, insertMove, shiftEntries } from '../../../state/modules/history-shift';
import { saveHyperlink } from '../../../state/modules/hyperlink';
import { mergeCells } from '../../../state/modules/merge';
import { deleteRowCol, insertRowCol } from '../../../state/modules/rowcol';
import { addSheet, changeSheet, deleteSheet, renameSheet } from '../../../state/modules/sheet';
import { updateFormatCell } from '../../../state/modules/toolbar';
import { clearValidations, validationAt } from '../../../state/modules/validation-rules';
import type { DataValidationRule, Op, Sheet } from '../../../state/types';
import { commutes } from '../../../state/utils/commute';
import type { Tab } from '../factories/collab';
import { author, join, tab, tabEdit, tabReceive, tabRedo, tabUndo } from '../factories/collab';
import { heldGraph, workbookContextFactory } from '../factories/context';
import { typed } from '../factories/edit-cycle';
import { cellLinks } from '../factories/links';
import { formatList, formatsOf } from '../factories/validations';

const ONE = 's1';
const TWO = 's2';
const THREE = 's3';
// The id the next added sheet gets: each test that adds one stubs crypto.randomUUID to return it.
const FOUR = '00000000-0000-4000-8000-000000000004';

afterEach(() => {
    mock.restore();
});

// 'B10' → [9, 1].
function at(a1: string): [number, number] {
    const [, letters, digits] = /^([A-Z]+)(\d+)$/.exec(a1) ?? [];
    return [Number(digits) - 1, letters.charCodeAt(0) - 65];
}

function sheet(id: string, name: string, order: number, cells: Record<string, Cell> = {}): Sheet {
    const data: (Cell | null)[][] = Array.from({ length: 40 }, () => Array.from({ length: 8 }, () => null));
    for (const [a1, cell] of Object.entries(cells)) {
        const [r, c] = at(a1);
        data[r][c] = cell;
    }
    return { id, name, order, row: 40, column: 8, data, config: {} };
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
const cells = (s: LibSheet) => (s.data ? dataToCelldata(s.data) : (s.celldata ?? []));
const view = (sheets: LibSheet[]) =>
    sheets.map((s) => ({ id: s.id, name: s.name, order: s.order, cells: cells(s), merge: s.config?.merge ?? {} }));

function expectAgree(s: ReturnType<typeof session>) {
    expect(view(s.b.ctx.sheets)).toEqual(view(s.a.ctx.sheets));
    expect(view(s.joiner())).toEqual(view(s.a.ctx.sheets));
}

// A chart on any sheet that reads B3:B6 of One.
const chartReading = (id: string) => ({
    ...newChartSpecParts({
        ...sampleChartSpec('column'),
        series: { 's-1': { ...DEFAULT_CHART_SERIES_STYLE, color: '#2a78d6' } },
        data: {
            source: 'range',
            categories: null,
            series: [{ id: 's-1', name: 'Points', values: { sheetId: ONE, row: [2, 5], column: [1, 1] } }],
        },
    }),
    id,
    index: 'a0',
    x: 0,
    y: 0,
    width: 100,
    height: 100,
});

const formulaRule = (formula: string, first = 0, last = 0): ReturnType<typeof formatList>[number] => ({
    type: 'default',
    conditionName: 'formula',
    conditionValue: [formula],
    ranges: [{ row: [first, last], column: [0, 0] }],
    format: {},
});

const byOrder = (x: LibSheet, y: LibSheet) => (x.order ?? 0) - (y.order ?? 0);

// All a reader holds of a sheet. A joiner holds the stored cells of a sheet its batches never wrote into.
const stored = (sheets: ShiftedSheet[]) =>
    sheets.toSorted(byOrder).map((s) => ({
        id: s.id,
        name: s.name,
        order: s.order,
        row: s.row,
        column: s.column,
        cells: cells(s),
        config: s.config,
        dataValidations: s.dataValidations ?? {},
        conditionalFormats: s.conditionalFormats,
        frozen: s.frozen,
        filterRange: s.filterRange,
        filter: s.filter,
        charts: s.charts,
    }));

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
const deleteColumns = (start: number, end: number, id = ONE) => {
    const op = { type: 'column', start, end, id } as const;
    return [(ctx: Context) => deleteRowCol(ctx, op), { deleteRowColOp: op }] as const;
};
const removeSheet = (id: string) => [(ctx: Context) => deleteSheet(ctx, id), { deleteSheetOp: { id } }] as const;
const renameTab = [
    (ctx: Context) => renameSheet(ctx, { id: ONE, name: 'Renamed' }),
    { renameSheetOp: { id: ONE } },
] as const;
type Structural = readonly [(ctx: Context) => void, Parameters<typeof tabEdit>[2]];

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

    test("a peer's row delete keeps the undo of an overwritten formula", () => {
        const s = session(workbook({ A1: num(1), C2: { f: '=A1', v: 1, m: '1' }, B10: { f: '=A1', v: 1, m: '1' } }));
        s.edit(s.a, typedAt('C2', '5'));
        s.edit(s.b, ...deleteRows(9, 9));
        expect(s.a.history.undoList).toHaveLength(1);
        s.undo(s.a);
        expect(cellAt(s.a, 'C2')).toMatchObject({ f: '=A1', v: 1 });
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
        tabReceive(s.a, peerInsert([{ op: 'insertRowCol', id: ONE, path: [], value: { type: 'row', index: -1 } }]));
        expect(cellAt(s.a, 'B10')?.v).toBe('new');
        tabUndo(s.a);
        expect(cellAt(s.a, 'B10')?.v).toBe('old');
    });

    test('a second batch before the next render shifts against the sheets the first one added', () => {
        const base = workbook({}, { A1: text('old') });
        const a = tab(base);
        const b = tab(base);
        spyOn(crypto, 'randomUUID').mockReturnValue(FOUR);
        const added = tabEdit(b, (ctx) => addSheet(ctx), { addSheetOp: true });
        const name = b.ctx.sheets[3].name;
        tabEdit(a, typedAt('A1', `=${name}!B10`, TWO));
        const inserted = tabEdit(b, ...insertRows(2, 2, FOUR));
        // One API takes both batches before A's next render, as the Workbook's does.
        let next = a.ctx;
        const setContext = (recipe: (ctx: Context) => void) => {
            next = produce(next, recipe);
        };
        const api = generateAPIs(
            () => next,
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

describe("undo after a peer's row op keeps a field its entry wrote", () => {
    test("a sheet's first link stays undoable after a peer's row insert", () => {
        const s = session(workbook({ B5: text('link') }));
        s.edit(s.a, (ctx) => saveHyperlink(ctx, 4, 1, 'link', 'webpage', 'https://eigen.is'));
        s.edit(s.b, ...insertRows(2, 2));
        s.undo(s.a);
        expect(cellLinks(s.a.ctx.sheets[0])).toEqual({});
        expectAgree(s);
    });

    // A point's style keeps its index through a row op, so the entry still holds what the recolour replaced.
    test("a chart's slice colour stays undoable after a peer's row insert in its rows", () => {
        const base = produce(workbook({}), (ctx: Context) => {
            ctx.sheets[0].charts = { c1: chartReading('c1') };
        });
        const s = session(base);
        const points = (sheets: LibSheet[]) => sheets[0].charts?.c1.specPoints;
        const recolor: ChartSpecChange = [{ op: 'set', path: ['points', 's-1', '1', 'color'], value: '#ff0000' }];
        s.edit(s.a, (ctx) => setChartSpec(ctx, 'c1', recolor));
        expect(points(s.b.ctx.sheets)).toBe('{"s-1":{"1":{"color":"#ff0000"}}}');
        s.edit(s.b, ...insertRows(4, 2));
        s.undo(s.a);
        expect([s.a.ctx.sheets, s.b.ctx.sheets, s.joiner()].map(points)).toEqual(['{}', '{}', '{}']);
    });
});

// A peer's batch ends your own sheet, row and column entries and everything older, on both stacks. What is newer stays
// and still follows the peer's rows.
describe("a peer's batch ends your row, column and sheet undo", () => {
    const peerTypes = (s: ReturnType<typeof session>) => s.edit(s.b, typedAt('H40', 'peer', THREE));

    const kinds: [string, Structural][] = [
        ['row insert', insertRows(4, 1)],
        ['column insert', insertColumns(4, 1)],
        ['row delete', deleteRows(4, 4)],
        ['sheet delete', removeSheet(TWO)],
        ['sheet add', [(ctx: Context) => addSheet(ctx), { addSheetOp: true }]],
        ['rename', renameTab],
    ];
    test.each(kinds)('a %s and everything older leave the undo stack, the newer stay', (_, structural) => {
        const s = session(workbook({ B2: text('old'), B3: text('old') }));
        s.edit(s.a, typedAt('B2', 'older'));
        s.edit(s.a, ...structural);
        s.edit(s.a, typedAt('B3', 'newer'));
        expect(s.a.history.undoList).toHaveLength(3);
        peerTypes(s);
        expect(s.a.history.undoList).toHaveLength(1);
        s.undo(s.a);
        expect(cellAt(s.a, 'B3')?.v).toBe('old');
        expect(cellAt(s.a, 'B2')?.v).toBe('older');
        const sent = s.batches.length;
        s.undo(s.a);
        expect(s.batches.length).toBe(sent);
        expect(cellAt(s.a, 'B2')?.v).toBe('older');
        expectAgree(s);
    });

    test('a structural entry and what redoes after it leave the redo stack, the entry on top stays', () => {
        const s = session(workbook({ B2: text('old') }));
        s.edit(s.a, typedAt('C5', 'below'));
        s.edit(s.a, ...insertRows(2, 1));
        s.edit(s.a, typedAt('B2', 'above'));
        s.undo(s.a);
        s.undo(s.a);
        s.undo(s.a);
        expect(s.a.history.redoList).toHaveLength(3);
        peerTypes(s);
        expect(s.a.history.redoList).toHaveLength(1);
        s.redo(s.a);
        expect(cellAt(s.a, 'C5')?.v).toBe('below');
        expect(s.a.history.redoList).toHaveLength(0);
        expectAgree(s);
    });

    test('a batch on any sheet ends it, and an entry older on another sheet goes too', () => {
        const s = session(workbook());
        s.edit(s.a, typedAt('A1', 'x', TWO));
        s.edit(s.a, ...insertRows(2, 1));
        s.edit(s.b, typedAt('A1', 'peer', THREE));
        expect(s.a.history.undoList).toEqual([]);
    });

    test('a batch that fails ends nothing', () => {
        const s = session(workbook());
        s.edit(s.a, ...insertRows(2, 1));
        tabReceive(s.a, [{ op: 'insertRowCol', id: ONE, path: [], value: { type: 'row', index: -1 } }]);
        expect(s.a.history.undoList).toHaveLength(1);
        s.undo(s.a);
        expect(s.a.ctx.sheets[0].data).toHaveLength(40);
        expectAgree(s);
    });

    test("your newer cell undo follows a peer's row insert after your own row op left the stack", () => {
        const s = session(workbook({ B10: text('old') }));
        s.edit(s.a, ...insertRows(2, 1));
        s.edit(s.a, typedAt('B11', 'new'));
        s.edit(s.b, ...insertRows(0, 2));
        expect(s.a.history.undoList).toHaveLength(1);
        s.undo(s.a);
        expect(cellAt(s.a, 'B13')?.v).toBe('old');
        expectAgree(s);
    });
});

// With no peer's batch since, an undo gives back exactly the workbook before the op, and a redo the one after it.
describe('working alone', () => {
    const merge = { r: 7, c: 0, rs: 2, cs: 2 };
    const rich = () => {
        const base = workbook(
            {
                A4: num(1),
                A5: num(2),
                A6: num(3),
                B1: { ...num(6), f: '=SUM(A4:A6)' },
                C1: { ...num(2), f: '=A5' },
                A8: { v: 'm', m: 'm', mc: merge },
                B8: { mc: { r: 7, c: 0 } },
                A9: { mc: { r: 7, c: 0 } },
                B9: { mc: { r: 7, c: 0 } },
            },
            { A1: { ...num(6), f: '=SUM(One!A4:A6)' }, A2: { ...num(3), f: '=One!A6' } },
        );
        return produce(base, (ctx: Context) => {
            const [one, two] = ctx.sheets;
            one.config = { ...one.config, merge: { '7_0': merge }, rowlen: { 4: 40 } };
            if (one.data)
                one.data[4][0] = { ...one.data[4][0], link: { type: 'webpage', address: 'https://eigen.is' } };
            one.dataValidations = {
                a: {
                    ranges: [{ row: [3, 5], column: [0, 0] }],
                    order: 'a0',
                    rule: { type: 'dropdown', type2: '', value1: 'a', value2: '' },
                },
            };
            one.config.borderInfo = { '4_0': { b: { style: 1, color: '#000' } } };
            one.config.rowhidden = { 6: 0 };
            one.frozen = { type: 'rangeBoth', range: { row_focus: 5, column_focus: 1 } };
            one.filterRange = { row: [2, 9], column: [0, 2] };
            one.filter = {
                0: { rowhidden: { 6: 0 }, optionstate: true, str: 2, edr: 9, cindex: 0, stc: 0, edc: 2 },
            };
            one.conditionalFormats = formatsOf([formulaRule('=A5>0', 3, 5)]);
            one.charts = { c1: chartReading('c1') };
            two.conditionalFormats = formatsOf([formulaRule('=One!A5>0')]);
            two.charts = { c2: chartReading('c2') };
        });
    };
    const shown = (t: Tab) => ({ sheets: stored(t.ctx.sheets) });

    const kinds: [string, Structural][] = [
        ['a row insert', insertRows(4, 2)],
        ['a column insert', insertColumns(0, 2)],
        ['a row insert inside a merge', insertRows(8, 1)],
        ['a row delete', deleteRows(4, 5)],
        ["a row delete of the filter's header row", deleteRows(2, 2)],
        ["a column delete of the filter's columns", deleteColumns(0, 2)],
        ['a column delete', deleteColumns(0, 1)],
        ['a row delete through a merge', deleteRows(8, 8)],
        ['a column delete through a merge', deleteColumns(1, 1)],
        ['a sheet delete', removeSheet(TWO)],
        ['a copy', [(ctx: Context) => copySheet(ctx, TWO), { addSheetOp: true }]],
        ['a rename', renameTab],
    ];
    test.each(kinds)('%s goes back and forth exactly, on both tabs and for a joiner', (_, structural) => {
        const s = session(rich());
        const before = shown(s.a);
        s.edit(s.a, ...structural);
        const after = shown(s.a);
        const everyReaderHolds = (state: ReturnType<typeof shown>) => {
            expect(shown(s.a)).toEqual(state);
            expect(stored(s.b.ctx.sheets)).toEqual(state.sheets);
            expect(stored(s.joiner())).toEqual(state.sheets);
        };
        expect(stored(s.b.ctx.sheets)).toEqual(after.sheets);
        for (let round = 0; round < 2; round += 1) {
            s.undo(s.a);
            everyReaderHolds(before);
            s.redo(s.a);
            everyReaderHolds(after);
        }
    });

    test('a long run undoes and redoes whole, every entry staying on its stack', () => {
        const s = session(rich());
        const before = shown(s.a);
        s.edit(s.a, typedAt('D2', 'one'));
        s.edit(s.a, ...insertRows(1, 1));
        s.edit(s.a, typedAt('D4', 'two'));
        s.edit(s.a, ...deleteRows(5, 6));
        s.edit(s.a, ...removeSheet(TWO));
        s.edit(s.a, typedAt('E1', 'three'));
        const after = shown(s.a);
        for (let i = 0; i < 6; i += 1) s.undo(s.a);
        expect(shown(s.a)).toEqual(before);
        expect(s.a.history).toMatchObject({ undoList: [], redoList: { length: 6 } });
        expectAgree(s);
        for (let i = 0; i < 6; i += 1) s.redo(s.a);
        expect(shown(s.a)).toEqual(after);
        expectAgree(s);
    });

    test('an undo ships only the entries its marker did not bring back', () => {
        const writesOfUndo = (...structural: Structural) => {
            const t = tab(rich());
            tabEdit(t, ...structural);
            return tabUndo(t).flatMap(({ path }) => (path.length > 0 && path[0] !== 'data' ? [path.join('/')] : []));
        };
        expect(writesOfUndo(...insertRows(4, 1))).toEqual([]);
        expect(writesOfUndo(...deleteRows(4, 4))).toEqual([
            'conditionalFormats/f1',
            'conditionalFormats/f1',
            'config/rowlen/4',
            'config/borderInfo/4_0',
        ]);
    });

    // A sheet past the row limit, as an import may bring: the delete applies, but the insert that would undo it fails.
    test('an undo whose marker fails changes nothing, sends nothing and leaves nothing to redo', () => {
        const base = workbook({ A5: text('gone'), A6: text('next') });
        const rows = Array.from({ length: MAX_SHEET_ROW_COUNT + 2 }, (_, r) => base.sheets[0].data?.[r] ?? [null]);
        const s = session(produce(base, (ctx: Context) => void (ctx.sheets[0].data = rows)));
        s.edit(s.a, ...deleteRows(4, 4));
        const sent = s.batches.length;
        const held = s.a.ctx;
        s.undo(s.a);
        expect(s.a.ctx).toBe(held);
        s.redo(s.a);
        expect(s.a.ctx).toBe(held);
        expect(s.batches).toHaveLength(sent);
        expect(s.a.history).toMatchObject({ undoList: [], redoList: [] });
        expect(cellAt(s.a, 'A5')?.v).toBe('next');
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

    test('a row insert moves them in a copy, which a joiner holds as stored cells', () => {
        const s = session(pointing());
        s.edit(s.a, (ctx) => copySheet(ctx, TWO), { addSheetOp: true });
        s.edit(s.b, ...insertRows(2, 2));
        expect(cells(s.a.ctx.sheets[3])[0].v?.f).toBe('=One!B12');
        expectAgree(s);
    });
});

// The engine rewrites a formula rule that names the op's sheet on every sheet, so an entry that holds such a rule
// would bring back its old text. It is dropped, as one on the op's own sheet is.
describe("a row op on another sheet drops the undo of a formula rule that reads the op's sheet", () => {
    const rules = (t: Tab) => formatList(t.ctx.sheets.find((x) => x.id === TWO)?.conditionalFormats);
    const withRules = (...formulas: string[]) =>
        produce(workbook(), (ctx: Context) => {
            ctx.sheets[1].conditionalFormats = formatsOf(formulas.map((formula) => formulaRule(formula)));
        });
    const expectSameRules = (s: ReturnType<typeof session>) => {
        expect(rules(s.b)).toEqual(rules(s.a));
        expect(formatList(s.joiner().find((x) => x.id === TWO)?.conditionalFormats)).toEqual(rules(s.a));
    };

    test('a deleted rule does not come back reading the row it read before the insert', () => {
        const s = session(withRules('=One!A5>0', '=A5>0'));
        s.edit(
            s.a,
            on(TWO, (ctx) => deleteSheetRule(ctx, 'f2')),
        );
        s.edit(
            s.a,
            on(TWO, (ctx) => deleteSheetRule(ctx, 'f1')),
        );
        s.edit(s.b, ...insertRows(0, 1));
        expect(s.a.history.undoList).toHaveLength(1);
        s.undo(s.a);
        s.undo(s.a);
        expect(rules(s.a)).toEqual([formulaRule('=A5>0')]);
        expectSameRules(s);
    });

    test('an undone add is not redone with the text it had before the insert', () => {
        const s = session(withRules());
        const add = (formula: string) =>
            on(TWO, (ctx) => {
                Object.assign(getSheet(ctx).conditionalFormats ?? {}, formatsOf([formulaRule(formula)]));
            });
        s.edit(s.a, add('=One!A5>0'));
        s.undo(s.a);
        s.edit(s.b, ...insertRows(0, 1));
        expect(s.a.history.redoList).toHaveLength(0);
        s.redo(s.a);
        expect(rules(s.a)).toEqual([]);
        expectSameRules(s);
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
    expect(cellLinks(s.a.ctx.sheets[0])).toStrictEqual({ '6_1': { type: 'webpage', address: 'https://eigen.is' } });
    expect(cellLinks(s.b.ctx.sheets[0])).toStrictEqual(cellLinks(s.a.ctx.sheets[0]));
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

    // A part is one string, so a peer's later edit of it holds the peer's whole part and the undo leaves it.
    test("a chart's style edit is not undone once a peer has edited the same part", () => {
        const base = produce(workbook({}), (ctx: Context) => {
            ctx.sheets[0].charts = { c1: chartReading('c1') };
        });
        const s = session(base);
        const series = (sheets: LibSheet[]) => JSON.parse(sheets[0].charts?.c1.specSeries ?? '{}')['s-1'];
        const set = (path: string[], value: unknown): ChartSpecChange => [{ op: 'set', path, value }];
        s.edit(s.a, (ctx) => setChartSpec(ctx, 'c1', set(['series', 's-1', 'color'], '#ff0000')));
        s.edit(s.b, (ctx) => setChartSpec(ctx, 'c1', set(['series', 's-1', 'line', 'smooth'], true)));
        s.undo(s.a);
        for (const sheets of [s.a.ctx.sheets, s.b.ctx.sheets, s.joiner()]) {
            expect(series(sheets)).toMatchObject({ color: '#ff0000', line: { smooth: true } });
        }
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

    // The entry's recorded total would go out as a batch that changes nothing, and end the peer's structural undos.
    test('an undo whose input a peer changed since sends nothing, though a formula reads that input', () => {
        const s = session(workbook({ A1: num(1), B1: num(2), D10: { ...num(3), f: '=A1+B1' } }));
        s.edit(s.a, typedAt('A1', '5'));
        s.edit(s.b, typedAt('A1', '7'));
        expect(tabUndo(s.a)).toEqual([]);
        expect(s.a.history).toMatchObject({ undoList: [], redoList: [] });
        expect(cellAt(s.a, 'D10')?.v).toBe(9);
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

    test.each([
        ['a date', { fa: 'yyyy-MM-dd', t: 'd' }, '1900-01-09'],
        ['a text', { fa: '@', t: 's' }, '10'],
    ])('the undo and redo of %s format give a formula its type and display', (_, ct, m) => {
        const general = { f: '=A1*2', v: 10, m: '10', ct: { fa: 'General', t: 'n' } };
        const s = session(workbook({ A1: num(5), B1: general }));
        s.edit(s.a, (ctx) => {
            const data = getFlowdata(ctx);
            if (data) updateFormatCell(ctx, data, 'ct', ct.fa, 0, 0, 1, 1);
        });
        s.undo(s.a);
        for (const t of [s.a, s.b]) expect(cellAt(t, 'B1')).toEqual(general);
        expectAgree(s);
        s.redo(s.a);
        for (const t of [s.a, s.b]) expect(cellAt(t, 'B1')).toEqual({ ...general, m, ct });
        expectAgree(s);
    });
});

test("a redone formula follows its inputs at its place after a peer's row insert", () => {
    const s = session(workbook({ A1: { v: 1, m: '1', ct: { fa: 'General', t: 'n' } } }));
    s.edit(s.a, typedAt('D10', '=A1*2'));
    s.edit(s.b, ...insertRows(2, 2));
    s.undo(s.a);
    s.redo(s.a);
    s.edit(s.b, typedAt('A1', '7'));
    for (const t of [s.a, s.b]) expect(cellAt(t, 'D12')?.v).toBe(14);
    expectAgree(s);
});

describe("a formula is its cell's `f`, nothing else", () => {
    const formula = (f: string, v = 1): Cell => ({ f, v, m: String(v) });

    test('both tabs undo their formulas, and the sheet still takes every commit', () => {
        const s = session(workbook());
        s.edit(s.a, typedAt('A1', '=1+1'));
        s.edit(s.b, typedAt('B1', '=2+2'));
        s.undo(s.a);
        s.undo(s.b);
        s.edit(s.a, typedAt('C1', 'hello'));
        s.edit(s.b, typedAt('C2', '=3+3'));
        for (const t of [s.a, s.b]) {
            expect(cellAt(t, 'A1')).toBeNull();
            expect(cellAt(t, 'C1')?.v).toBe('hello');
            expect(cellAt(t, 'C2')?.v).toBe(6);
        }
        expectAgree(s);
    });

    test('a new sheet keeps a formula through a row insert, its undo and redo, for a joiner too', () => {
        spyOn(crypto, 'randomUUID').mockReturnValue(FOUR);
        const s = session(workbook());
        s.edit(s.a, (ctx) => addSheet(ctx, undefined, 'New'), { addSheetOp: true });
        s.edit(s.a, ...insertRows(2, 1, FOUR));
        s.undo(s.a);
        s.redo(s.a);
        s.edit(s.a, typedAt('C3', '=1+1', FOUR));
        expect(s.joiner().find((one) => one.id === FOUR)?.data?.[2]?.[2]?.v).toBe(2);
        expect(cellAt(s.b, 'C3', FOUR)?.v).toBe(2);
    });

    test('a new sheet keeps later formulas for a joiner after a formula, its undo and a row insert', () => {
        spyOn(crypto, 'randomUUID').mockReturnValue(FOUR);
        const s = session(workbook());
        s.edit(s.a, (ctx) => addSheet(ctx, undefined, 'New'), { addSheetOp: true });
        s.edit(s.a, typedAt('A1', '=1+1', FOUR));
        s.undo(s.a);
        s.edit(s.a, ...insertRows(5, 1, FOUR));
        s.edit(s.a, typedAt('C3', '=2+2', FOUR));
        expect(s.joiner().find((one) => one.id === FOUR)?.data?.[2]?.[2]?.v).toBe(4);
        expect(cellAt(s.b, 'C3', FOUR)?.v).toBe(4);
    });

    test("undoing your own formula leaves a peer's formula following its inputs once the map rebuilds", () => {
        const s = session(workbook({ A1: num(1) }));
        s.edit(s.a, typedAt('C1', '=A1'));
        s.edit(s.b, typedAt('D1', '=A1*2'));
        s.undo(s.a);
        s.edit(s.b, ...insertRows(20, 1));
        s.edit(s.b, typedAt('A1', '10'));
        for (const t of [s.a, s.b]) expect(cellAt(t, 'D1')?.v).toBe(20);
        expectAgree(s);
    });

    test("an undone formula leaves a peer's overwrites alone, and a later row op reaches every reader", () => {
        const s = session(workbook({ A1: num(1), B1: formula('=A1'), B2: formula('=A1') }));
        s.edit(s.a, typedAt('D1', '=A1'));
        s.edit(s.b, typedAt('B1', '5'));
        s.edit(s.b, typedAt('B2', '6'));
        s.undo(s.a);
        s.edit(s.b, typedAt('E1', 'typed'));
        s.edit(s.a, ...insertRows(5, 1));
        for (const sheets of [s.a.ctx.sheets, s.b.ctx.sheets, s.joiner()]) expect(sheets[0].data).toHaveLength(41);
        expectAgree(s);
    });

    test("an undo leaves a peer's formula following its inputs once the map rebuilds", () => {
        const s = session(workbook({ A1: num(1), B1: formula('=A1') }));
        s.edit(s.a, typedAt('B1', '5'));
        s.edit(s.b, typedAt('C1', '=A1*2'));
        s.undo(s.a);
        s.edit(s.b, ...insertRows(20, 1));
        s.edit(s.b, typedAt('A1', '10'));
        for (const t of [s.a, s.b]) {
            expect(cellAt(t, 'B1')?.v).toBe(10);
            expect(cellAt(t, 'C1')?.v).toBe(20);
        }
        expectAgree(s);
    });

    test("two formulas typed at once commute, so each tab keeps its undo and the peer's formula", () => {
        const base = workbook({ A1: num(1) });
        const a = tab(base);
        const b = tab(base);
        const fromA = tabEdit(a, typedAt('C1', '=A1'));
        const fromB = tabEdit(b, typedAt('D1', '=A1*2'));
        expect(commutes([fromB], [fromA])).toBe(true);
        expect(commutes([fromA], [fromB])).toBe(true);
        tabReceive(a, fromB);
        tabReceive(b, fromA);
        expect(view(a.ctx.sheets)).toEqual(view(b.ctx.sheets));
        expect(view(join(base, [fromA, fromB]))).toEqual(view(a.ctx.sheets));
        tabReceive(b, tabUndo(a));
        expect(a.history.redoList).toHaveLength(1);
        expect(b.history.undoList).toHaveLength(1);
        expect(cellAt(b, 'C1')).toBeNull();
        expect(cellAt(b, 'D1')?.v).toBe(2);
    });

    test('a row written past the end is skipped, so the matrix keeps no holes and the map still builds', () => {
        const t = tab(workbook());
        const rows = t.ctx.sheets[0].data?.length ?? 0;
        tabReceive(t, [{ op: 'replace', id: ONE, path: ['data', rows + 9], value: [{ f: '=1+1', v: 2, m: '2' }] }]);
        t.ctx.formulaCache.forgetGraph();
        expect(t.ctx.sheets[0].data).toHaveLength(rows);
        expect(heldGraph(t.ctx).formulaAt(ONE, rows + 9, 0)).toBeUndefined();
    });
});

describe('a structural undo or redo applies exactly what it sends', () => {
    // A formula cell as the engine leaves it, which is what an undo's recalculation writes back.
    const formula = (f: string, v: number): Cell => ({ ...num(v), f });
    const sums = () =>
        workbook(
            {
                A4: num(1),
                A5: num(2),
                A6: num(3),
                A8: num(4),
                B1: formula('=SUM(A4:A8)', 10),
                C1: formula('=A5', 2),
            },
            { A1: formula('=SUM(One!A4:A8)', 10), A2: formula('=One!A6', 3) },
        );

    test('undoing your row delete brings the cells and formulas back', () => {
        const base = sums();
        const s = session(base);
        s.edit(s.a, ...deleteRows(4, 5));
        expect(cellAt(s.a, 'C1')?.f).toContain('#REF!');
        s.undo(s.a);
        for (const a1 of ['A4', 'A5', 'A6', 'A8', 'B1', 'C1']) expect(cellAt(s.a, a1)).toEqual(cellAt(tab(base), a1));
        for (const a1 of ['A1', 'A2']) expect(cellAt(s.a, a1, TWO)).toEqual(cellAt(tab(base), a1, TWO));
        expectAgree(s);
        s.redo(s.a);
        expect(cellAt(s.a, 'A6')?.v).toBe(4);
        expectAgree(s);
    });

    test("undoing your row delete brings back the deleted rows' height and link", () => {
        const base = produce(workbook({ B5: text('link') }), (ctx: Context) => {
            ctx.sheets[0].config = { ...ctx.sheets[0].config, rowlen: { 4: 40 } };
            const row = ctx.sheets[0].data?.[4];
            if (row) row[1] = { ...row[1], link: { type: 'webpage', address: 'https://eigen.is' } };
        });
        const s = session(base);
        s.edit(s.a, ...deleteRows(4, 5));
        s.undo(s.a);
        for (const sheets of [s.a.ctx.sheets, s.b.ctx.sheets, s.joiner()]) {
            expect(sheets[0].config?.rowlen).toEqual({ 4: 40 });
            expect(cellLinks(sheets[0])).toEqual(cellLinks(base.sheets[0]));
        }
        expectAgree(s);
    });

    test('undoing your row delete brings back a formula it broke in a copy, which a joiner holds as stored cells', () => {
        const s = session(workbook({ A5: num(3) }, { A1: { f: '=One!A5', v: 3, m: '3' } }));
        s.edit(s.a, (ctx) => copySheet(ctx, TWO), { addSheetOp: true });
        s.edit(s.a, ...deleteRows(4, 4));
        expect(cells(s.a.ctx.sheets[3])[0].v?.f).toContain('#REF!');
        s.undo(s.a);
        for (const sheets of [s.a.ctx.sheets, s.b.ctx.sheets, s.joiner()]) {
            expect(cells(sheets[3])[0].v?.f).toBe('=One!A5');
        }
        expectAgree(s);
    });

    test.each<[string, Structural]>([
        ['row', deleteRows(4, 4)],
        ['column', deleteColumns(0, 0)],
    ])(
        'undoing a %s delete brings back a formula rule on another sheet that named it, and redo breaks it again',
        (_, deletion) => {
            const base = produce(workbook({ A5: num(3) }), (ctx: Context) => {
                ctx.sheets[1].conditionalFormats = formatsOf([formulaRule('=One!A5>0')]);
            });
            const s = session(base);
            const everyReaderReads = (formula: string) => {
                for (const sheets of [s.a.ctx.sheets, s.b.ctx.sheets, s.joiner()]) {
                    const [rule] = formatList(sheets[1].conditionalFormats);
                    expect(rule.type === 'default' && rule.conditionValue).toEqual([formula]);
                }
            };
            s.edit(s.a, ...deletion);
            everyReaderReads('=#REF!>0');
            s.undo(s.a);
            everyReaderReads('=One!A5>0');
            s.redo(s.a);
            everyReaderReads('=#REF!>0');
        },
    );

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

    test('undoing a delete that cut a merge to one cell brings the merge back everywhere', () => {
        const merge = { r: 4, c: 0, rs: 2, cs: 1 };
        const base = produce(
            workbook({ A5: { v: 'm', m: 'm', mc: merge }, A6: { mc: { r: 4, c: 0 } } }),
            (ctx: Context) => {
                ctx.sheets[0].config = { ...ctx.sheets[0].config, merge: { '4_0': merge } };
            },
        );
        const s = session(base);
        s.edit(s.a, ...deleteRows(5, 5));
        expect(s.a.ctx.sheets[0].config?.merge).toEqual({});
        expect(cellAt(s.a, 'A5')?.mc).toBeUndefined();
        expectAgree(s);
        s.undo(s.a);
        expect(s.a.ctx.sheets[0].config?.merge).toEqual({ '4_0': merge });
        expect(cellAt(s.a, 'A5')?.mc).toEqual(merge);
        expect(cellAt(s.a, 'A6')?.mc).toEqual({ r: 4, c: 0 });
        expectAgree(s);
    });

    // B's batch sits before A's undo in the log, and A's undo was built without it.
    function undoBehindPeer(base: Context, deletion: Structural, onB: (ctx: Context) => void) {
        const s = session(base);
        s.edit(s.a, ...deletion);
        const fromB = tabEdit(s.b, onB);
        const step = tabUndo(s.a);
        tabReceive(s.a, fromB);
        tabReceive(s.b, step);
        return [s.a.ctx.sheets, s.b.ctx.sheets, join(base, [...s.batches, fromB, step])];
    }
    const side = { style: 1, color: '#000000' };
    const widenAndBorder = (ctx: Context) => {
        const { columnlen, borderInfo } = ctx.sheets[0].config ?? {};
        if (columnlen) columnlen[1] = 200;
        if (borderInfo) borderInfo['0_1'] = { b: side };
    };

    test('undoing your row delete keeps a column width and a border a peer set meanwhile', () => {
        const base = produce(workbook({ A5: text('kept') }), (ctx: Context) => {
            ctx.sheets[0].config = { ...ctx.sheets[0].config, rowlen: { 4: 40 } };
        });
        for (const sheets of undoBehindPeer(base, deleteRows(4, 4), widenAndBorder)) {
            expect(sheets[0].config).toMatchObject({
                rowlen: { 4: 40 },
                columnlen: { 1: 200 },
                borderInfo: { '0_1': { b: side } },
            });
        }
    });

    test("undoing a delete of merged rows keeps a peer's merge and border, and brings its own back whole", () => {
        const merge = { r: 4, c: 0, rs: 2, cs: 2 };
        const corner = { mc: { r: 4, c: 0 } };
        const base = produce(
            workbook({ A5: { v: 'm', m: 'm', mc: merge }, B5: corner, A6: corner, B6: corner }),
            (ctx: Context) => {
                ctx.sheets[0].config = { ...ctx.sheets[0].config, merge: { '4_0': merge } };
            },
        );
        const readers = undoBehindPeer(base, deleteRows(4, 5), (ctx) => {
            widenAndBorder(ctx);
            mergeCells(ctx, ONE, [{ row: [0, 1], column: [3, 4] }], 'merge-all');
        });
        for (const sheets of readers) {
            expect(sheets[0].config?.merge).toEqual({ '4_0': merge, '0_3': { r: 0, c: 3, rs: 2, cs: 2 } });
            expect(sheets[0].config?.borderInfo).toEqual({ '0_1': { b: side } });
            const mcs = cells(sheets[0]).flatMap(({ r, c, v }) => (v?.mc ? [`${r}_${c}`] : []));
            expect(mcs.toSorted()).toEqual(['0_3', '0_4', '1_3', '1_4', '4_0', '4_1', '5_0', '5_1']);
        }
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

    test("a peer's edit to a sheet you restored applies on your side", () => {
        const s = session(workbook({}, { A1: text('two') }));
        s.edit(s.a, ...removeSheet(TWO));
        s.undo(s.a);
        s.edit(s.b, typedAt('B2', 'peer', TWO));
        expect(cellAt(s.a, 'B2', TWO)?.v).toBe('peer');
        expectAgree(s);
    });

    test('undoing the delete of a copy brings back its cells', () => {
        const s = session(workbook({}, { A1: text('two') }));
        s.edit(s.a, (ctx) => copySheet(ctx, TWO), { addSheetOp: true });
        const copy = s.a.ctx.sheets[3];
        s.edit(s.a, ...removeSheet(String(copy.id)));
        s.undo(s.a);
        expect(view(s.a.ctx.sheets)[3].cells).toEqual([{ r: 0, c: 0, v: text('two') }]);
        expectAgree(s);
    });

    test("a peer's edit to a copy you made applies on your side", () => {
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
        spyOn(crypto, 'randomUUID').mockReturnValue(FOUR);
        s.edit(s.a, (ctx) => addSheet(ctx), { addSheetOp: true });
        expect(view(s.b.ctx.sheets).map((x) => x.id)).toEqual([ONE, TWO, THREE, FOUR]);
        s.undo(s.a);
        expect(view(s.a.ctx.sheets).map((x) => x.id)).toEqual([ONE, TWO, THREE]);
        expectAgree(s);
        s.redo(s.a);
        expect(view(s.a.ctx.sheets).map((x) => x.id)).toEqual([ONE, TWO, THREE, FOUR]);
        expectAgree(s);
    });
});

// Two tabs that add or delete a sheet before the other's batch arrives leave two sheets on one order, or a gap. The log
// puts A's batch first, so B applies the log again from before its own.
describe('sheet orders after two tabs change the sheet list at once', () => {
    const tabOrder = (sheets: readonly LibSheet[]) => sheets.toSorted(byOrder).map((s) => s.id);
    const orders = (sheets: readonly LibSheet[]) => sheets.map((s) => [s.id, s.order]);

    function atOnce(onA: Structural, onB: Structural) {
        const base = workbook();
        const s = session(base);
        const fromA = tabEdit(s.a, ...onA);
        const fromB = tabEdit(tab(base), ...onB);
        s.batches.push(fromA, fromB);
        tabReceive(s.a, fromB);
        for (const batch of s.batches) tabReceive(s.b, batch);
        expectAgree(s);
        return s;
    }

    const added = (id: string): Structural => [(ctx) => addSheet(ctx, id, id), { addSheetOp: true }];

    test.each<[string, () => ReturnType<typeof session>, Structural]>([
        ['two adds, then a delete of one', () => atOnce(added('X'), added('Y')), removeSheet('X')],
        [
            'two deletes, then a copy',
            () => atOnce(removeSheet(ONE), removeSheet(TWO)),
            [(ctx) => copySheet(ctx, THREE), { addSheetOp: true }],
        ],
    ])('%s: every reader holds the same orders, and undo and redo bring them back', (_, start, edit) => {
        const s = start();
        const before = tabOrder(s.a.ctx.sheets);
        s.edit(s.a, ...edit);
        expectAgree(s);
        const after = orders(s.a.ctx.sheets);
        s.undo(s.a);
        expectAgree(s);
        expect(tabOrder(s.a.ctx.sheets)).toEqual(before);
        s.redo(s.a);
        expectAgree(s);
        expect(orders(s.a.ctx.sheets)).toEqual(after);
    });
});

// The Workbook's replay of the log from `base`, as a late batch that doesn't commute with the tab's own makes it.
function replayLog(t: Tab, base: Context, log: Op[][], late: Op[]) {
    generateAPIs(
        () => t.ctx,
        (recipe) => {
            t.ctx = produce(t.ctx, recipe);
        },
        () => {},
        () => {},
        t.history,
    ).replayOps(base.sheets, log, new Set([late]));
}

// One and Two are the last sheets shown, and each tab takes one away before the other's batch arrives. The log puts A's
// batch first, and B takes it as the Workbook takes a late batch: on top when it commutes, else by a replay.
describe('two tabs taking away the last two sheets shown at once', () => {
    const shown = (sheets: readonly LibSheet[]) => sheets.filter((s) => s.hide !== 1).map((s) => s.id);

    test.each<[string, Structural, Structural]>([
        ['deletes', removeSheet(TWO), removeSheet(ONE)],
        [
            'hides',
            [(ctx) => hideSheet(ctx, TWO), {}],
            [
                (ctx) => {
                    changeSheet(ctx, TWO);
                    hideSheet(ctx, ONE);
                },
                {},
            ],
        ],
    ])('two %s: the later does nothing, on both tabs and for a joiner', (_, onA, onB) => {
        const base = produce(workbook(), (ctx: Context) => {
            ctx.sheets[2].hide = 1;
        });
        const a = tab(base);
        const b = tab(base);
        const fromA = tabEdit(a, ...onA);
        const fromB = tabEdit(b, ...onB);
        const log = [fromA, fromB];
        tabReceive(a, fromB);
        if (commutes([fromA], [fromB])) tabReceive(b, fromA);
        else replayLog(b, base, log, fromA);
        expect(shown(a.ctx.sheets)).toEqual([ONE]);
        expect(view(b.ctx.sheets)).toEqual(view(a.ctx.sheets));
        expect(shown(b.ctx.sheets)).toEqual([ONE]);
        expect(view(join(base, log))).toEqual(view(a.ctx.sheets));
        expect(shown(join(base, log))).toEqual([ONE]);
    });

    test('an undo that would hide the last sheet shown does nothing', () => {
        const base = produce(workbook(), (ctx: Context) => {
            ctx.sheets[1].hide = 1;
            ctx.sheets[2].hide = 1;
        });
        const s = session(base);
        s.edit(s.a, (ctx) => showSheet(ctx, TWO));
        s.edit(s.b, (ctx) => {
            changeSheet(ctx, TWO);
            hideSheet(ctx, ONE);
        });
        s.undo(s.a);
        expect(shown(s.a.ctx.sheets)).toEqual([TWO]);
        expect(shown(s.b.ctx.sheets)).toEqual([TWO]);
        expect(shown(s.joiner())).toEqual([TWO]);
    });
});

// Two tabs pressing + at once both name the new tab Sheet4. The log puts A's add first, so B applies the log again from
// before its own.
describe('two tabs adding a sheet of one name at once', () => {
    test('the later add takes the next free name and keeps its cells, on both tabs and for a joiner', () => {
        const base = workbook();
        const a = tab(base);
        const b = tab(base);
        const fromA = tabEdit(a, (ctx) => addSheet(ctx, 'x'), { addSheetOp: true });
        const fromB = tabEdit(b, (ctx) => addSheet(ctx, 'y'), { addSheetOp: true });
        const typedInB = tabEdit(b, (ctx) => {
            changeSheet(ctx, 'y');
            typed(0, 0, 'kept')(ctx);
        });
        const log = [fromA, fromB, typedInB];
        tabReceive(a, fromB);
        tabReceive(a, typedInB);
        replayLog(b, base, log, fromA);
        const names = (sheets: readonly LibSheet[]) => sheets.map((s) => [s.id, s.name]);
        expect(names(a.ctx.sheets).slice(3)).toEqual([
            ['x', 'Sheet4'],
            ['y', 'Sheet4 (2)'],
        ]);
        expect(a.ctx.sheets[4].data?.[0]?.[0]?.v).toBe('kept');
        expect(view(b.ctx.sheets)).toEqual(view(a.ctx.sheets));
        expect(view(join(base, log))).toEqual(view(a.ctx.sheets));
    });

    // A name stored before imports repaired names can break the sheet-name rule, and its copy's name keeps the break.
    test('a copy of a tab whose stored name breaks the rule lands repaired, and its undo takes it away', () => {
        const base = produce(workbook(), (ctx: Context) => {
            ctx.sheets[0].name = 'Q1: Sales';
        });
        const a = tab(base);
        tabEdit(a, (ctx) => copySheet(ctx, ONE), { addSheetOp: true });
        expect(a.ctx.sheets.map((s) => s.name)).toEqual(['Q1: Sales', 'Two', 'Three', 'Q1_ Sales(Copy)']);
        tabUndo(a);
        expect(a.ctx.sheets.map((s) => s.id)).toEqual([ONE, TWO, THREE]);
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
    const rows = (index: number, count: number) =>
        insertMove({ id: ONE, type: 'row', index, count, direction: 'lefttop' });
    const deletedRows = (start: number, end: number) => deleteMove({ id: ONE, type: 'row', start, end });
    const columns = (index: number, count: number) =>
        insertMove({ id: ONE, type: 'column', index, count, direction: 'lefttop' });
    const onOne = chartReading('c1');
    const sheets: Sheet[] = [
        { ...sheet(ONE, 'One', 0), charts: { c1: onOne } },
        { ...sheet(TWO, 'Two', 1), charts: { c2: { ...onOne, id: 'c2' } } },
    ];
    const replace = (path: Patch['path'], value?: unknown): Patch => ({ op: 'replace', path, value });
    const at = (...path: Patch['path']) => ['sheets', ONE, ...path];
    const range = (row: number[]) => ({ row, column: [1, 1] });
    const greaterThan = { type: 'default', conditionName: 'greaterThan', conditionValue: [1], format: {}, order: 'a0' };

    test.each<[string, RowColMove, Patch, Patch | null]>([
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
            replace(at('data', 5, 1, 'link'), { type: 'webpage' }),
            replace(at('data', 7, 1, 'link'), { type: 'webpage' }),
        ],
        [
            "a validation rule's ranges move, the one an insert is inside grows",
            rows(2, 2),
            replace(at('dataValidations', 'v'), {
                ranges: [range([5, 6]), range([1, 3])],
                order: 'a0',
                rule: { type: 'checkbox' },
            }),
            replace(at('dataValidations', 'v'), {
                ranges: [range([7, 8]), range([1, 5])],
                order: 'a0',
                rule: { type: 'checkbox' },
            }),
        ],
        [
            'a validation rule a delete shrinks keeps what is left',
            deletedRows(2, 3),
            replace(at('dataValidations', 'v'), {
                ranges: [range([3, 6]), range([2, 3])],
                order: 'a0',
                rule: { type: 'checkbox' },
            }),
            replace(at('dataValidations', 'v'), { ranges: [range([2, 4])], order: 'a0', rule: { type: 'checkbox' } }),
        ],
        [
            'a validation rule a delete takes whole drops the entry',
            deletedRows(2, 3),
            replace(at('dataValidations', 'v'), { ranges: [range([2, 3])], order: 'a0', rule: { type: 'checkbox' } }),
            null,
        ],
        [
            "a validation rule's removal stays",
            deletedRows(2, 3),
            { op: 'remove', path: at('dataValidations', 'v') },
            { op: 'remove', path: at('dataValidations', 'v') },
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
        ['a whole matrix drops the entry', rows(1, 1), replace(at('data'), [[{ v: 1 }]]), null],
        [
            'a whole row moves with a row insert',
            rows(2, 2),
            replace(at('data', 5), [{ v: 1 }]),
            replace(at('data', 7), [{ v: 1 }]),
        ],
        [
            'a conditional format written under its id moves its ranges',
            rows(2, 2),
            replace(at('conditionalFormats', 'f1'), { ...greaterThan, ranges: [range([5, 6])] }),
            replace(at('conditionalFormats', 'f1'), { ...greaterThan, ranges: [range([7, 8])] }),
        ],
        [
            'a formula conditional format drops the entry',
            rows(2, 2),
            replace(at('conditionalFormats', 'f1'), {
                ...greaterThan,
                conditionName: 'formula',
                ranges: [range([5, 6])],
            }),
            null,
        ],
        ['a whole row drops the entry on a column insert', columns(2, 2), replace(at('data', 5), []), null],
        ["a chart's data on One drops the entry", rows(2, 2), replace(at('charts', 'c1', 'specData'), '{}'), null],
        [
            'a chart on Two reading One drops the entry too',
            rows(2, 2),
            replace(['sheets', TWO, 'charts', 'c2', 'specData'], '{}'),
            null,
        ],
        [
            "a chart's slice colours stay, since a point keeps its index",
            rows(2, 2),
            replace(at('charts', 'c1', 'specPoints'), '{"s-1":{"0":{"color":"#ff0000"}}}'),
            replace(at('charts', 'c1', 'specPoints'), '{"s-1":{"0":{"color":"#ff0000"}}}'),
        ],
        ["a chart's box stays", rows(2, 2), replace(at('charts', 'c1', 'x'), 5), replace(at('charts', 'c1', 'x'), 5)],
        ['the name stays', rows(2, 2), replace(at('name'), 'Uno'), replace(at('name'), 'Uno')],
    ])('%s', (_, marker, patch, expected) => {
        const [shifted] = shiftEntries([{ patches: [patch], inversePatches: [], options: {} }], marker, sheets);
        expect<Patch | null>(shifted?.patches[0] ?? null).toEqual(expected);
    });
});

// Each validation rule is written under its own id, so two peers editing different rules keep both edits, and a peer's
// row op moves an undo's rules with the cells they cover. Columns A and B each hold a list rule over rows 1 to 10.
describe('validation rules on two tabs and a joiner', () => {
    const LIST: DataValidationRule = { type: 'dropdown', type2: '', value1: 'a,b', value2: '' };
    const TICKS: DataValidationRule = { type: 'checkbox', type2: '', value1: 'TRUE', value2: 'FALSE' };
    const rules = (t: Tab) => t.ctx.sheets[0].dataValidations;
    const apply = (row: number[], column: number[], rule: DataValidationRule) => (ctx: Context) =>
        applyDataValidation(ctx, { row, column }, rule);
    const column = (t: Tab, c: number, rows: number) =>
        Array.from({ length: rows }, (_, r) => validationAt(rules(t), r, c)?.type ?? null);
    const repeat = (type: string | null, n: number) => Array<string | null>(n).fill(type);
    function ruled() {
        const base = workbook();
        base.sheets[0].dataValidations = {
            a: { ranges: [{ row: [0, 9], column: [0, 0] }], order: 'a0', rule: LIST },
            b: { ranges: [{ row: [0, 9], column: [1, 1] }], order: 'a0', rule: LIST },
        };
        return base;
    }

    test('two peers editing different rules at once keep both edits', () => {
        const base = ruled();
        const a = tab(base);
        const b = tab(base);
        const fromA = tabEdit(a, apply([0, 1], [0, 0], TICKS));
        const fromB = tabEdit(b, (ctx) => clearValidations(ctx.sheets[0], { row: [5, 9], column: [1, 1] }));
        tabReceive(a, fromB);
        tabReceive(b, fromA);
        expect(rules(b)).toEqual(rules(a));
        expect(join(base, [fromA, fromB])[0].dataValidations).toEqual(rules(a));
        expect(column(a, 0, 4)).toEqual([...repeat('checkbox', 2), ...repeat('dropdown', 2)]);
        expect(column(a, 1, 10)).toEqual([...repeat('dropdown', 5), ...repeat(null, 5)]);
    });

    test("an undo after a peer's row insert gives the cut rule its moved cells back, and redo puts the rule back", () => {
        const s = session(ruled());
        const applied = [...repeat('dropdown', 6), ...repeat('checkbox', 2), ...repeat('dropdown', 4)];
        s.edit(s.a, apply([4, 5], [0, 0], TICKS));
        s.edit(s.b, ...insertRows(2, 2));
        expect(column(s.a, 0, 12)).toEqual(applied);
        s.undo(s.a);
        expect(column(s.a, 0, 13)).toEqual([...repeat('dropdown', 12), null]);
        expect(rules(s.b)).toEqual(rules(s.a));
        expect(s.joiner()[0].dataValidations).toEqual(rules(s.a));
        s.redo(s.a);
        expect(column(s.a, 0, 12)).toEqual(applied);
        expect(rules(s.b)).toEqual(rules(s.a));
        expect(s.joiner()[0].dataValidations).toEqual(rules(s.a));
    });

    test('a row delete over a rule moves it on both tabs and the joiner, and its undo brings the rule back', () => {
        const s = session(ruled());
        s.edit(s.a, apply([4, 5], [0, 0], TICKS));
        s.edit(s.a, ...deleteRows(3, 6));
        expect(column(s.a, 0, 7)).toEqual([...repeat('dropdown', 6), null]);
        expect(rules(s.b)).toEqual(rules(s.a));
        expect(s.joiner()[0].dataValidations).toEqual(rules(s.a));
        s.undo(s.a);
        const restored = [...repeat('dropdown', 4), ...repeat('checkbox', 2), ...repeat('dropdown', 4)];
        expect(column(s.a, 0, 10)).toEqual(restored);
        expect(column(s.b, 0, 10)).toEqual(restored);
        expect(s.joiner()[0].dataValidations).toEqual(rules(s.a));
    });

    // Both tabs edit before either sees the other's batch, and the log holds B's batch first.
    function race(
        base: Context,
        onA: readonly [(ctx: Context) => void, Parameters<typeof tabEdit>[2]],
        onB: (ctx: Context) => void,
    ) {
        const a = tab(base);
        const b = tab(base);
        const fromB = tabEdit(b, onB);
        const fromA = tabEdit(a, ...onA);
        tabReceive(a, fromB);
        tabReceive(b, fromA);
        return { a, b, joined: join(base, [fromB, fromA])[0].dataValidations };
    }

    // A tab whose own batch the log puts after a peer's applies the log again, so it ends as a tab that took the
    // batches in the log's order.
    function inLogOrder(base: Context, batches: Op[][]) {
        const t = tab(base);
        for (const ops of batches) tabReceive(t, ops);
        return t;
    }
    const rangesOfA = (validations: Sheet['dataValidations']) => validations?.a?.ranges;

    test('two row inserts sent at once leave a rule on its cells on both tabs and the joiner', () => {
        const base = workbook({ A5: text('x'), A6: text('y') });
        base.sheets[0].dataValidations = { a: { ranges: [{ row: [4, 5], column: [0, 0] }], order: 'a0', rule: LIST } };
        const a = tab(base);
        const b = tab(base);
        const fromA = tabEdit(a, ...insertRows(0, 1));
        const fromB = tabEdit(b, ...insertRows(0, 1));
        tabReceive(a, fromB);
        const onB = inLogOrder(base, [fromA, fromB]);
        expect(cellAt(a, 'A7')?.v).toBe('x');
        for (const validations of [rules(a), rules(onB), join(base, [fromA, fromB])[0].dataValidations]) {
            expect(rangesOfA(validations)).toEqual([{ row: [6, 7], column: [0, 0] }]);
        }
    });

    test("a row insert sent with a peer's cut of a rule moves the cut rule on both tabs and the joiner", () => {
        const base = ruled();
        const a = tab(base);
        const b = tab(base);
        const fromA = tabEdit(a, ...insertRows(0, 1));
        const fromB = tabEdit(b, (ctx) => clearValidations(ctx.sheets[0], { row: [5, 9], column: [0, 0] }));
        tabReceive(b, fromA);
        const onA = inLogOrder(base, [fromB, fromA]);
        for (const validations of [rules(onA), rules(b), join(base, [fromB, fromA])[0].dataValidations]) {
            expect(rangesOfA(validations)).toEqual([{ row: [1, 5], column: [0, 0] }]);
        }
    });

    test("a row insert made before a peer's new rule arrived keeps that rule on both tabs and the joiner", () => {
        const { a, b, joined } = race(ruled(), insertRows(2, 1), apply([0, 1], [3, 3], TICKS));
        for (const validations of [rules(a), rules(b), joined]) {
            expect(Object.values(validations ?? {}).map(({ rule }) => rule.type)).toContain('checkbox');
        }
        expect(joined).toEqual(rules(b));
    });

    // A inserts a row, then undoes it while B's edit is on its way, and B's batch comes first in the log.
    function raceUndo(onB: (ctx: Context) => void, redo = false) {
        const s = session(ruled());
        s.edit(s.a, ...insertRows(2, 1));
        if (redo) s.undo(s.a);
        const fromB = tabEdit(s.b, onB);
        const step = redo ? tabRedo(s.a) : tabUndo(s.a);
        tabReceive(s.a, fromB);
        tabReceive(s.b, step);
        return { ...s, joined: join(ruled(), [...s.batches, fromB, step])[0].dataValidations };
    }

    test('an undo of a row insert keeps a rule a peer added meanwhile', () => {
        const { a, b, joined } = raceUndo(apply([0, 1], [3, 3], TICKS));
        for (const validations of [rules(a), rules(b), joined]) {
            expect(Object.values(validations ?? {}).map(({ rule }) => rule.type)).toContain('checkbox');
        }
        expect(joined).toEqual(rules(b));
    });

    test("a row insert made before a peer's rule delete arrived leaves the rule deleted", () => {
        const { a, b, joined } = race(ruled(), insertRows(2, 1), (ctx) =>
            clearValidations(ctx.sheets[0], { row: [0, 9], column: [1, 1] }),
        );
        for (const validations of [rules(a), rules(b), joined]) expect(Object.keys(validations ?? {})).toEqual(['a']);
        expect(joined).toEqual(rules(b));
    });

    // The undo of a delete sends the rule the delete took whole under its own id, so a rule B added meanwhile stays.
    test('an undo of a row delete that took a rule keeps a rule a peer added meanwhile', () => {
        const s = session(ruled());
        s.edit(s.a, apply([4, 5], [0, 0], TICKS));
        s.edit(s.a, ...deleteRows(3, 6));
        const fromB = tabEdit(s.b, apply([0, 1], [3, 3], TICKS));
        const step = tabUndo(s.a);
        tabReceive(s.a, fromB);
        tabReceive(s.b, step);
        const joined = join(ruled(), [...s.batches, fromB, step])[0].dataValidations;
        for (const validations of [rules(s.a), rules(s.b), joined]) {
            expect(validationAt(validations, 0, 3)?.type).toBe('checkbox');
            expect(validationAt(validations, 4, 0)?.type).toBe('checkbox');
        }
        expect(joined).toEqual(rules(s.b));
    });

    test('an undo of a row insert keeps a cut of a rule the peer sent at once', () => {
        const { b, joined } = raceUndo((ctx) => clearValidations(ctx.sheets[0], { row: [8, 10], column: [0, 0] }));
        const cut = [{ row: [0, 6], column: [0, 0] }];
        for (const validations of [rules(b), joined]) expect(rangesOfA(validations)).toEqual(cut);
    });

    test('an undo and a redo of a row insert leave a rule a peer deleted meanwhile deleted', () => {
        const clearB = (ctx: Context) => clearValidations(ctx.sheets[0], { row: [0, 10], column: [1, 1] });
        for (const redo of [false, true]) {
            const { a, b, joined } = raceUndo(clearB, redo);
            for (const validations of [rules(a), rules(b), joined])
                expect(Object.keys(validations ?? {})).toEqual(['a']);
            expect(joined).toEqual(rules(b));
        }
    });
});
