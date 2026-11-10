// Copy, cut, move and the format painter over a range with a hidden row and a hidden column inside it. As in
// Excel, the hidden cells travel with the rest: their values, formats, borders, validation, links and merges land
// at the destination, and the destination's rows and columns keep the hidden state they had. Only a copy over
// rows an active filter hides leaves those rows out, and then the side tables close up with the cells. A cut or a
// move over such a row, and a copy of a merge that straddles one, gets a notice and writes nothing.
//
// The source block is A1:D4 with row 2 and column B hidden. Three cells carry a border, a validation rule and a
// link: A1 before the hidden lines, B2 on both of them, C3 after them. C1:D1 and A3:A4 are merged. The paste
// lands at G7, and row 9 of the destination was hidden beforehand.

import { describe, expect, test } from 'bun:test';
import type { DataValidationRule, SheetValidation } from '@workspace/lib/sheets';
import { MAX_VALIDATION_RANGES } from '@workspace/lib/sheets';
import { Window } from 'happy-dom';
import type { SingleRange } from '../../engine/types';
import type { Context } from '../../state/context';
import { handleCopy, handleCut } from '../../state/events/copy';
import { handlePaste } from '../../state/events/paste';
import { carriedLines, carryCells } from '../../state/modules/carry';
import { consumePendingCopy } from '../../state/modules/clipboard';
import { onCellsMoveEnd } from '../../state/modules/move-cells';
import { pasteHandlerOfPaintModel } from '../../state/modules/selection';
import { handleFormatPainter } from '../../state/modules/toolbar';
import { validationAt } from '../../state/modules/validation-rules';
import type { Cell, GlobalCache, Op, Selection } from '../../state/types';
import { clipboardWith, copied, pasteCopy } from './factories/clipboard';
import { author, join, receive } from './factories/collab';
import { contextFactory, editInPlace, workbookContextFactory } from './factories/context';
import { gridElements, withGridGeometry } from './factories/grid-dom';
import { cellLinks } from './factories/links';
import { validationsByCell } from './factories/validations';

// biome-ignore lint/suspicious/noExplicitAny: test-only globalThis injection
const g = globalThis as any;
// A paste the copy state can't serve parses the clipboard's table, so it needs a DOM.
g.DOMParser = new Window().DOMParser;

const SIZE = 12;
const SIDE = { style: 1, color: '#000' };
const MOVE_REFUSAL = 'Cannot cut or move rows a filter hides. Clear the filter first.';
const MERGE_REFUSAL = 'Cannot copy merged cells a filter partly hides. Clear the filter first.';
const MARKED = [
    [0, 0],
    [1, 1],
    [2, 2],
] as const;

function rule(r: number, c: number): DataValidationRule {
    return {
        type: 'dropdown',
        type2: '',
        value1: `list ${r}${c}`,
        value2: '',
        prohibitInput: false,
        hintShow: false,
        hintValue: '',
    };
}

function link(r: number, c: number) {
    return { type: 'webpage', address: `https://eigen.is/${r}${c}` };
}

function cellAt(r: number, c: number): Cell {
    const text = `r${r}c${c}`;
    return { v: text, m: text, bg: `#${r}${c}0000` };
}

function emptyGrid(): (Cell | null)[][] {
    return Array.from({ length: SIZE }, () => Array.from({ length: SIZE }, () => null));
}

function makeCtx({ filtered = false } = {}): Context {
    const data = emptyGrid();
    for (let r = 0; r < 4; r += 1) for (let c = 0; c < 4; c += 1) data[r][c] = cellAt(r, c);
    data[0][2] = { ...cellAt(0, 2), mc: { r: 0, c: 2, rs: 1, cs: 2 } };
    data[0][3] = { mc: { r: 0, c: 2 } };
    data[2][0] = { ...cellAt(2, 0), mc: { r: 2, c: 0, rs: 2, cs: 1 } };
    data[3][0] = { mc: { r: 2, c: 0 } };
    for (const [r, c] of MARKED) data[r][c] = { ...cellAt(r, c), link: link(r, c) };
    const borderInfo = Object.fromEntries(MARKED.map(([r, c]) => [`${r}_${c}`, { t: SIDE, l: SIDE }]));
    const dataValidations = validationsByCell(Object.fromEntries(MARKED.map(([r, c]) => [`${r}_${c}`, rule(r, c)])));
    const ctx = withGridGeometry(
        contextFactory({
            sheets: [
                {
                    name: 'sheet',
                    id: 'id_1',
                    order: 0,
                    data,
                    config: {
                        rowhidden: { 1: 0, 8: 0 },
                        colhidden: { 1: 0 },
                        borderInfo,
                        merge: {
                            '0_2': { r: 0, c: 2, rs: 1, cs: 2 },
                            '2_0': { r: 2, c: 0, rs: 2, cs: 1 },
                        },
                    },
                    dataValidations,
                    ...(filtered && {
                        filterRange: { row: [0, 3], column: [0, 3] },
                        filter: {
                            0: { rowhidden: { 1: 0 }, optionstate: true, str: 0, edr: 3, cindex: 0, stc: 0, edc: 3 },
                        },
                    }),
                },
            ],
            selections: source(),
            visibledatarow: Array.from({ length: SIZE }, (_, i) => (i + 1) * 20),
            visibledatacolumn: Array.from({ length: SIZE }, (_, i) => (i + 1) * 74),
        }) as Context,
    );
    return ctx;
}

// The lines of a range no filter touches.
function linesOf(ctx: Context, range: SingleRange) {
    const lines = carriedLines(ctx, 'id_1', [range]);
    if (!lines) throw new Error('a test range with no filter is refused');
    return lines;
}

function source(): Selection[] {
    return [{ row: [0, 3], column: [0, 3], row_focus: 0, column_focus: 0 }];
}

function destination(): Selection[] {
    return [{ row: [6, 6], column: [6, 6], row_focus: 6, column_focus: 6 }];
}

function paste(ctx: Context, cut: boolean) {
    if (cut) handleCut(ctx);
    else handleCopy(ctx);
    ctx.selections = destination();
    pasteCopy(ctx);
}

// ⌘V: the browser hands over the table the copy put on the clipboard.
function pasteFromClipboard(ctx: Context) {
    const html = consumePendingCopy()?.html ?? '';
    editInPlace(ctx, (draft) => {
        draft.selections = destination();
        handlePaste(draft, clipboardWith({ html }));
    });
}

function paint(ctx: Context) {
    handleFormatPainter(ctx);
    ctx.selections = destination();
    if (ctx.painterSource) pasteHandlerOfPaintModel(ctx, ctx.painterSource);
}

// Drags A1:D4 by its top-left cell onto G7.
function move(ctx: Context) {
    ctx.cellSelectMoving = true;
    ctx.cellSelectMoveIndex = [0, 0];
    const { container, scrollEl } = gridElements();
    const event = { clientX: 46 + 6 * 74 + 30, clientY: 20 + 6 * 20 + 10 } as MouseEvent;
    editInPlace(ctx, (draft) => onCellsMoveEnd(draft, {} as GlobalCache, event, scrollEl, container));
}

const sheet = (ctx: Context) => ctx.sheets[0];
const key = (r: number, c: number) => `${r}_${c}`;

// Every source cell (r, c) lands at (r + 6, c + 6), each side table with it.
function expectCarriedWhole(ctx: Context, { links = true } = {}) {
    const s = sheet(ctx);
    for (const [r, c] of MARKED) {
        expect(s.config?.borderInfo?.[key(r + 6, c + 6)]).toEqual({ t: SIDE, l: SIDE });
        expect(validationAt(s.dataValidations, r + 6, c + 6)).toEqual(rule(r, c));
        expect(cellLinks(s)[key(r + 6, c + 6)]).toEqual(links ? link(r, c) : undefined);
    }
    // Nothing lands on the cell beside a marked one, as an index one off would.
    for (const [r, c] of [
        [6, 7],
        [7, 8],
        [8, 9],
    ]) {
        expect(s.config?.borderInfo?.[key(r, c)]).toBeUndefined();
        expect(validationAt(s.dataValidations, r, c)).toBeUndefined();
        expect(cellLinks(s)[key(r, c)]).toBeUndefined();
    }
    expect(s.config?.merge?.[key(6, 8)]).toEqual({ r: 6, c: 8, rs: 1, cs: 2 });
    expect(s.config?.merge?.[key(8, 6)]).toEqual({ r: 8, c: 6, rs: 2, cs: 1 });
    expect(s.data?.[6][9]?.mc).toEqual({ r: 6, c: 8 });
    expect(s.data?.[9][6]?.mc).toEqual({ r: 8, c: 6 });
    // The destination keeps its own hidden rows and columns, row 9 included, and gains none.
    expect(s.config?.rowhidden).toEqual({ 1: 0, 8: 0 });
    expect(s.config?.colhidden).toEqual({ 1: 0 });
}

function expectValuesWhole(ctx: Context) {
    const d = sheet(ctx).data;
    for (const [r, c] of [
        [0, 0],
        [1, 1],
        [1, 3],
        [2, 2],
        [3, 3],
        [0, 2],
        [2, 0],
    ]) {
        expect(d?.[r + 6][c + 6]?.v).toBe(`r${r}c${c}`);
    }
}

function expectSourceCleared(ctx: Context) {
    const s = sheet(ctx);
    for (let r = 0; r < 4; r += 1) for (let c = 0; c < 4; c += 1) expect(s.data?.[r][c]).toBeNull();
    for (const [r, c] of MARKED) {
        expect(s.config?.borderInfo?.[key(r, c)]).toBeUndefined();
        expect(validationAt(s.dataValidations, r, c)).toBeUndefined();
        expect(cellLinks(s)[key(r, c)]).toBeUndefined();
    }
    expect(s.config?.merge?.[key(0, 2)]).toBeUndefined();
    expect(s.config?.merge?.[key(2, 0)]).toBeUndefined();
}

describe('a range with a hidden row and column inside it', () => {
    test('a copy pastes the hidden cells too, each side table beside its cell', () => {
        const ctx = makeCtx();
        paste(ctx, false);
        expectValuesWhole(ctx);
        expectCarriedWhole(ctx);
        expect(sheet(ctx).data?.[1][1]?.v).toBe('r1c1');
    });

    test('a cut pastes the hidden cells rather than losing them', () => {
        const ctx = makeCtx();
        editInPlace(ctx, (draft) => paste(draft, true));
        expectValuesWhole(ctx);
        expectCarriedWhole(ctx);
        expectSourceCleared(ctx);
    });

    test('a move carries the hidden cells too', () => {
        const ctx = makeCtx();
        move(ctx);
        expectValuesWhole(ctx);
        expectCarriedWhole(ctx);
        expectSourceCleared(ctx);
    });

    test('the format painter paints the hidden cells too, and leaves the values and links', () => {
        const ctx = makeCtx();
        paint(ctx);
        expectCarriedWhole(ctx, { links: false });
        const d = sheet(ctx).data;
        expect(d?.[7][7]?.bg).toBe('#110000');
        expect(d?.[8][8]?.bg).toBe('#220000');
        expect(d?.[7][7]?.v).toBeUndefined();
    });

    // The other sheet has no links. A painted cell that kept the source's link marker would ship a write to a link
    // that sheet doesn't have, and the replay would drop the whole paint.
    test('the format painter onto another sheet replays for a reader who opens the workbook', () => {
        const base = makeCtx();
        base.sheets.push({ name: 'other', id: 'id_2', order: 1, data: emptyGrid(), config: {} });
        handleFormatPainter(base);
        const { next, ops } = author(base, (ctx) => {
            ctx.currentSheetId = 'id_2';
            ctx.selections = destination();
            if (ctx.painterSource) pasteHandlerOfPaintModel(ctx, ctx.painterSource);
        });
        expect(next.sheets[1].data?.[7][7]?.link).toBeUndefined();
        const joined = join(base, [ops]).find((s) => s.id === 'id_2');
        expect(joined?.data?.[7][7]?.bg).toBe('#110000');
    });

    test('the clipboard carries the hidden row and column', () => {
        const ctx = makeCtx();
        const text = copied(ctx, source())?.cellText;
        expect(text?.split('\n')).toEqual([
            'r0c0\tr0c1\tr0c2\t',
            'r1c0\tr1c1\tr1c2\tr1c3',
            'r2c0\tr2c1\tr2c2\tr2c3',
            '\tr3c1\tr3c2\tr3c3',
        ]);
    });
});

// The filter hides row 2, and column B stays hidden by hand. Source rows 1, 3 and 4 land on rows 7, 8 and 9.
describe('a range with a row an active filter hides', () => {
    function expectCompacted(ctx: Context, { links = true } = {}) {
        const s = sheet(ctx);
        // A1 lands on G7 and C3 on I8, with their side tables. B2 stays behind.
        expect(s.config?.borderInfo?.[key(6, 6)]).toEqual({ t: SIDE, l: SIDE });
        expect(s.config?.borderInfo?.[key(7, 8)]).toEqual({ t: SIDE, l: SIDE });
        expect(s.config?.borderInfo?.[key(7, 7)]).toBeUndefined();
        expect(s.config?.borderInfo?.[key(8, 8)]).toBeUndefined();
        expect(validationAt(s.dataValidations, 6, 6)).toEqual(rule(0, 0));
        expect(validationAt(s.dataValidations, 7, 8)).toEqual(rule(2, 2));
        expect(validationAt(s.dataValidations, 7, 7)).toBeUndefined();
        expect(validationAt(s.dataValidations, 8, 8)).toBeUndefined();
        expect(cellLinks(s)[key(6, 6)]).toEqual(links ? link(0, 0) : undefined);
        expect(cellLinks(s)[key(7, 8)]).toEqual(links ? link(2, 2) : undefined);
        expect(cellLinks(s)[key(7, 7)]).toBeUndefined();
        expect(s.config?.merge?.[key(6, 8)]).toEqual({ r: 6, c: 8, rs: 1, cs: 2 });
        expect(s.config?.merge?.[key(7, 6)]).toEqual({ r: 7, c: 6, rs: 2, cs: 1 });
        expect(s.data?.[8][6]?.mc).toEqual({ r: 7, c: 6 });
        expect(s.config?.rowhidden).toEqual({ 1: 0, 8: 0 });
        expect(s.config?.colhidden).toEqual({ 1: 0 });
    }

    test('a copy leaves the filtered row out, and the side tables close up with it', () => {
        const ctx = makeCtx({ filtered: true });
        paste(ctx, false);
        const d = sheet(ctx).data;
        expect(d?.[6][6]?.v).toBe('r0c0');
        expect(d?.[7][7]?.v).toBe('r2c1');
        expect(d?.[8][9]?.v).toBe('r3c3');
        expect(d?.[9][6]).toBeNull();
        expectCompacted(ctx);
    });

    test('the format painter leaves the filtered row out the same way', () => {
        const ctx = makeCtx({ filtered: true });
        paint(ctx);
        const d = sheet(ctx).data;
        expect(d?.[7][7]?.bg).toBe('#210000');
        expectCompacted(ctx, { links: false });
    });

    test('the clipboard leaves the filtered row out', () => {
        const ctx = makeCtx({ filtered: true });
        const text = copied(ctx, source())?.cellText;
        expect(text?.split('\n')).toEqual(['r0c0\tr0c1\tr0c2\t', 'r2c0\tr2c1\tr2c2\tr2c3', '\tr3c1\tr3c2\tr3c3']);
    });

    test('a cut is refused with a notice, and writes neither the sheet nor the clipboard', () => {
        consumePendingCopy();
        const { next, ops } = author(makeCtx({ filtered: true }), handleCut);
        expect(next.warnDialog).toBe(MOVE_REFUSAL);
        expect(next.copyState).toBeUndefined();
        expect(consumePendingCopy()).toBeNull();
        expect(ops).toEqual([]);
    });

    test('a move is refused with a notice, and the cells stay', () => {
        const ctx = makeCtx({ filtered: true });
        move(ctx);
        expect(ctx.warnDialog).toBe(MOVE_REFUSAL);
        expect(sheet(ctx).data?.[1][1]?.v).toBe('r1c1');
        expect(sheet(ctx).data?.[6][6]).toBeNull();
    });

    test('a cut of the rows around the filtered one moves them', () => {
        const ctx = makeCtx({ filtered: true });
        ctx.selections = [{ row: [2, 3], column: [0, 3], row_focus: 2, column_focus: 0 }];
        editInPlace(ctx, (draft) => paste(draft, true));
        expect(ctx.warnDialog).toBeUndefined();
        expect(sheet(ctx).data?.[6][6]?.v).toBe('r2c0');
        expect(sheet(ctx).data?.[2][1]).toBeNull();
    });

    // A1:A3 has the filtered row inside it, and A2:A3 has it as its first row.
    test.each([
        [0, 2],
        [1, 2],
    ])('a copy of a merge over rows %i to %i is refused with a notice', (first, last) => {
        consumePendingCopy();
        const ctx = makeCtx({ filtered: true });
        mergeColumnA(ctx, first, last);
        handleCopy(ctx);
        expect(ctx.warnDialog).toBe(MERGE_REFUSAL);
        expect(ctx.copyState).toBeUndefined();
        expect(consumePendingCopy()).toBeNull();
    });

    test('the format painter over a straddled merge gets the notice and paints nothing', () => {
        const ctx = makeCtx({ filtered: true });
        mergeColumnA(ctx, 0, 2);
        paint(ctx);
        expect(ctx.warnDialog).toBe(MERGE_REFUSAL);
        expect(sheet(ctx).data?.[6][6]).toBeNull();
    });

    test('a straddled merge outside the copied range is no reason to refuse', () => {
        const ctx = makeCtx({ filtered: true });
        mergeColumnA(ctx, 0, 2);
        ctx.selections = [{ row: [0, 3], column: [1, 3], row_focus: 0, column_focus: 1 }];
        handleCopy(ctx);
        expect(ctx.warnDialog).toBeUndefined();
        expect(ctx.copyState).toBeDefined();
    });

    test('a merge the filter hides whole stays out with its rows', () => {
        const ctx = makeCtx({ filtered: true });
        mergeColumnA(ctx, 1, 2);
        const s = sheet(ctx);
        for (const hidden of [s.config?.rowhidden, s.filter?.[0].rowhidden]) if (hidden) hidden[2] = 0;
        expect(tableGrid(copied(ctx, source())?.html ?? '')).toEqual([
            ['r0c0', 'r0c1', 'r0c2', ''],
            ['r3c0', 'r3c1', 'r3c2', 'r3c3'],
        ]);
    });

    // The paste reads the live cells, so a filter applied after the copy or the cut counts.
    describe('applied after the copy', () => {
        const filterRowB = (ctx: Context) => {
            sheet(ctx).filter = makeCtx({ filtered: true }).sheets[0].filter;
        };

        test('a cut is refused at its paste, and the cells stay', () => {
            const ctx = makeCtx();
            editInPlace(ctx, (draft) => {
                handleCut(draft);
                filterRowB(draft);
                draft.selections = destination();
                pasteCopy(draft);
            });
            expect(ctx.warnDialog).toBe(MOVE_REFUSAL);
            expect(sheet(ctx).data?.[1][1]?.v).toBe('r1c1');
            expect(sheet(ctx).data?.[6][6]).toBeNull();
        });

        test('a copy whose merge the filter now straddles is refused at its paste', () => {
            const ctx = makeCtx();
            mergeColumnA(ctx, 0, 2);
            editInPlace(ctx, (draft) => {
                handleCopy(draft);
                filterRowB(draft);
                draft.selections = destination();
                pasteCopy(draft);
            });
            expect(ctx.warnDialog).toBe(MERGE_REFUSAL);
            expect(sheet(ctx).data?.[6][6]).toBeNull();
        });
    });

    describe('only what is filter-hidden counts', () => {
        const cutWhole = (ctx: Context) => {
            editInPlace(ctx, (draft) => paste(draft, true));
            expect(ctx.warnDialog).toBeUndefined();
            expectValuesWhole(ctx);
            expectSourceCleared(ctx);
        };

        test('a row shown again since the filter hid it is cut', () => {
            const ctx = makeCtx({ filtered: true });
            delete sheet(ctx).config?.rowhidden?.[1];
            cutWhole(ctx);
        });

        // The importer reads a filter's span and no entries, so an imported filter's rows read as hidden by hand.
        test("an imported filter's hidden row is cut", () => {
            const ctx = makeCtx();
            sheet(ctx).filterRange = { row: [0, 3], column: [0, 3] };
            cutWhole(ctx);
        });

        test('a row hidden by hand while a filter is on is cut and copied', () => {
            const ctx = makeCtx({ filtered: true });
            const rowhidden = sheet(ctx).config?.rowhidden;
            if (rowhidden) rowhidden[2] = 0;
            ctx.selections = [{ row: [2, 3], column: [0, 3], row_focus: 2, column_focus: 0 }];
            expect(copied(ctx, ctx.selections)?.cellText.split('\n')).toEqual([
                'r2c0\tr2c1\tr2c2\tr2c3',
                '\tr3c1\tr3c2\tr3c3',
            ]);
            editInPlace(ctx, (draft) => paste(draft, true));
            expect(ctx.warnDialog).toBeUndefined();
            expect(sheet(ctx).data?.[6][6]?.v).toBe('r2c0');
        });
    });
});

// The clipboard's table is the copy's own, so ⌘V serves it from the copy state, with every side table, rather than
// as a table from another app.
describe('a paste of the clipboard in the same tab', () => {
    test.each([false, true])('takes the copy state, with a filter: %p', (filtered) => {
        const ctx = makeCtx({ filtered });
        handleCopy(ctx);
        pasteFromClipboard(ctx);
        expect(validationAt(sheet(ctx).dataValidations, 6, 6)).toEqual(rule(0, 0));
        expect(cellLinks(sheet(ctx))[key(6, 6)]).toEqual(link(0, 0));
    });

    test('takes the copy state for a cut', () => {
        const ctx = makeCtx();
        handleCut(ctx);
        pasteFromClipboard(ctx);
        expectValuesWhole(ctx);
        expectSourceCleared(ctx);
    });
});

// H7 takes B1, which has no rule and no link, and M12 is outside the paste. Both have a rule and a link of their own.
describe('a paste over cells with a rule and a link of their own', () => {
    function makeOwnCtx() {
        const ctx = makeCtx();
        const s = sheet(ctx);
        for (const [r, c] of [
            [6, 7],
            [11, 11],
        ]) {
            (s.dataValidations ??= {})[key(r, c)] = { ranges: [{ row: [r, r], column: [c, c] }], rule: rule(r, c) };
            if (s.data) s.data[r][c] = { ...s.data[r][c], link: link(r, c) };
        }
        return ctx;
    }

    // A write of a whole map would undo a peer's concurrent rule on another cell.
    const wholeMapWrites = (ops: Op[]) => ops.filter((op) => op.path.length === 1 && op.path[0] === 'dataValidations');

    test("a copy takes the source cell's lack of both, and writes only the cells it lands on", () => {
        const { next, ops } = author(makeOwnCtx(), (ctx) => paste(ctx, false));
        const s = sheet(next);
        expect(validationAt(s.dataValidations, 6, 7)).toBeUndefined();
        expect(cellLinks(s)[key(6, 7)]).toBeUndefined();
        expect(validationAt(s.dataValidations, 11, 11)).toEqual(rule(11, 11));
        expect(cellLinks(s)[key(11, 11)]).toEqual(link(11, 11));
        expect(wholeMapWrites(ops)).toEqual([]);
    });

    test("the format painter takes the source cell's lack of a rule, and leaves the link", () => {
        const { next, ops } = author(makeOwnCtx(), paint);
        const s = sheet(next);
        expect(validationAt(s.dataValidations, 6, 7)).toBeUndefined();
        expect(cellLinks(s)[key(6, 7)]).toEqual(link(6, 7));
        expect(validationAt(s.dataValidations, 11, 11)).toEqual(rule(11, 11));
        expect(wholeMapWrites(ops)).toEqual([]);
    });
});

// A rule is stored once over its ranges. Column A's rule covers A1:A4, and a wider one covers F6:L12, under the paste.
describe('a carried rule lands as ranges', () => {
    function rangesCtx() {
        const ctx = makeCtx();
        sheet(ctx).dataValidations = {
            column: { ranges: [{ row: [0, 3], column: [0, 0] }], rule: rule(9, 9) },
            wide: { ranges: [{ row: [5, 11], column: [5, 11] }], rule: rule(8, 8) },
        };
        ctx.sheets.push({ name: 'other', id: 'id_2', order: 1, data: emptyGrid(), config: {}, dataValidations: {} });
        return ctx;
    }
    const toOtherSheet = (ctx: Context) => {
        ctx.currentSheetId = 'id_2';
    };

    test('a copy on its own sheet adds the landed range to the rule, and cuts the rule it lands on', () => {
        const { next, ops } = author(rangesCtx(), (ctx) => paste(ctx, false));
        expect(sheet(next).dataValidations).toEqual({
            column: {
                ranges: [
                    { row: [0, 3], column: [0, 0] },
                    { row: [6, 9], column: [6, 6] },
                ],
                rule: rule(9, 9),
            },
            wide: {
                ranges: [
                    { row: [5, 5], column: [5, 11] },
                    { row: [6, 9], column: [5, 5] },
                    { row: [6, 9], column: [10, 11] },
                    { row: [10, 11], column: [5, 11] },
                ],
                rule: rule(8, 8),
            },
        });
        const paths = ops.filter((op) => op.path[0] === 'dataValidations').map((op) => op.path);
        expect(paths).toEqual(
            expect.arrayContaining([
                ['dataValidations', 'column'],
                ['dataValidations', 'wide'],
            ]),
        );
        expect(paths.every((path) => path.length === 2)).toBe(true);
    });

    test('a copy onto another sheet makes a rule of its own there', () => {
        const ctx = rangesCtx();
        handleCopy(ctx);
        toOtherSheet(ctx);
        ctx.selections = destination();
        pasteCopy(ctx);
        expect(Object.values(ctx.sheets[1].dataValidations ?? {})).toEqual([
            { ranges: [{ row: [6, 9], column: [6, 6] }], rule: rule(9, 9) },
        ]);
        expect(Object.keys(sheet(ctx).dataValidations ?? {})).toEqual(['column', 'wide']);
    });

    test('a cut onto another sheet takes the rule off the cells it cut', () => {
        const ctx = rangesCtx();
        editInPlace(ctx, (draft) => {
            handleCut(draft);
            toOtherSheet(draft);
            draft.selections = destination();
            pasteCopy(draft);
        });
        expect(Object.values(ctx.sheets[1].dataValidations ?? {})).toEqual([
            { ranges: [{ row: [6, 9], column: [6, 6] }], rule: rule(9, 9) },
        ]);
        expect(Object.keys(sheet(ctx).dataValidations ?? {})).toEqual(['wide']);
    });

    // The lookup gives a cell two rules cover to the highest id, so the carry lands the rules in that order too.
    test('where two source rules overlap, the landed cell takes the rule the source cell shows', () => {
        const ctx = workbookContextFactory({
            currentSheetId: 'id_1',
            sheets: [
                {
                    name: 'sheet',
                    id: 'id_1',
                    order: 0,
                    data: Array.from({ length: 4 }, () => [null, null, null, null]),
                    dataValidations: {
                        b: { ranges: [{ row: [0, 1], column: [0, 0] }], rule: rule(0, 0) },
                        a: { ranges: [{ row: [1, 2], column: [0, 0] }], rule: rule(2, 0) },
                    },
                },
            ],
        });
        const { next } = author(ctx, (draft) => {
            const lines = linesOf(draft, { row: [0, 2], column: [0, 0] });
            carryCells(draft, lines, [{ row: 0, column: 2, height: 3, width: 1 }], ({ source }) => source);
        });
        const shown = (c: number) => [0, 1, 2].map((r) => validationAt(sheet(next).dataValidations, r, c));
        expect(shown(2)).toEqual(shown(0));
        expect(shown(2)).toEqual([rule(0, 0), rule(0, 0), rule(2, 0)]);
    });

    // Each tile adds its landed range to the rule, so without coalescing the rule would hold 10,001 ranges.
    test('one validated cell pasted down 10,000 rows lands as one range', () => {
        const rows = 10_000;
        const ctx = workbookContextFactory({
            currentSheetId: 'id_1',
            sheets: [
                {
                    name: 'sheet',
                    id: 'id_1',
                    order: 0,
                    data: Array.from({ length: rows }, () => [null, null, null, null]),
                    dataValidations: { v: { ranges: [{ row: [0, 0], column: [1, 1] }], rule: rule(0, 1) } },
                },
            ],
        });
        const tiles = Array.from({ length: rows }, (_, row) => ({ row, column: 3, height: 1, width: 1 }));
        const { next } = author(ctx, (draft) => {
            const lines = linesOf(draft, { row: [0, 0], column: [1, 1] });
            carryCells(draft, lines, tiles, ({ source }) => source);
        });
        expect(sheet(next).dataValidations?.v.ranges).toEqual([
            { row: [0, 0], column: [1, 1] },
            { row: [0, rows - 1], column: [3, 3] },
        ]);
    });

    // Each tile used to clear the destination's rules on its own, rewriting every rule once a tile: 21 s here.
    test('a cell pasted down 10,000 rows of a column of 100 rules clears them once, in a moment', () => {
        const rows = 10_000;
        const cellRange = (r: number, c: number) => ({ row: [r, r], column: [c, c] });
        const scattered = Object.fromEntries(
            Array.from({ length: 100 }, (_, k) => [
                `r${k}`,
                { ranges: Array.from({ length: 20 }, (_, i) => cellRange((k * 20 + i) * 5, 3)), rule: rule(0, 3) },
            ]),
        );
        const ctx = workbookContextFactory({
            currentSheetId: 'id_1',
            sheets: [
                {
                    name: 'sheet',
                    id: 'id_1',
                    order: 0,
                    data: Array.from({ length: rows }, () => [null, null, null, null]),
                    dataValidations: { ...scattered, v: { ranges: [cellRange(0, 1)], rule: rule(0, 1) } },
                },
            ],
        });
        const tiles = Array.from({ length: rows }, (_, row) => ({ row, column: 3, height: 1, width: 1 }));
        const started = performance.now();
        const { next } = author(ctx, (draft) => {
            const lines = linesOf(draft, cellRange(0, 1));
            carryCells(draft, lines, tiles, ({ source }) => source);
        });
        expect(performance.now() - started).toBeLessThan(2000);
        expect(Object.keys(sheet(next).dataValidations ?? {})).toEqual(['v']);
    });

    // A1 holds a rule and A2 none, so each tile lands the rule on every other row: more ranges than a rule may hold,
    // which a peer, the server and a reload would drop. The cells land, the rule stops extending, and every reader
    // ends up with the same sheet.
    describe('a carry past the caps', () => {
        const rows = 20_000;
        const area = (rowEnd: number, column: number) => ({ row: [0, rowEnd], column: [column, column] });
        const atCap = Array.from({ length: MAX_VALIDATION_RANGES }, (_, i) => ({
            row: [2 * i + 1, 2 * i + 1],
            column: [1, 3],
        }));
        const capCtx = (dataValidations: Record<string, SheetValidation>) => {
            const data = Array.from({ length: rows }, (): (Cell | null)[] => [null, null, null, null]);
            data[0][0] = { v: 'a', m: 'a' };
            return workbookContextFactory({
                currentSheetId: 'id_1',
                sheets: [{ name: 'sheet', id: 'id_1', order: 0, data, dataValidations }],
                selections: [{ ...area(1, 0), row_focus: 0, column_focus: 0 }],
            });
        };
        const paste = (base: Context, target: { row: number[]; column: number[] }) =>
            author(base, (draft) => {
                handleCopy(draft);
                draft.selections = [{ ...target, row_focus: target.row[0], column_focus: target.column[0] }];
                pasteCopy(draft);
            });
        const expectEveryReaderAgrees = (base: Context, next: Context, ops: Op[]) => {
            const peer = receive(base, ops);
            expect(peer.sheets[0].dataValidations).toEqual(next.sheets[0].dataValidations);
            expect(peer.sheets[0].data?.[0]?.[2]?.v).toBe(next.sheets[0].data?.[0]?.[2]?.v);
            const [joined] = join(base, [ops]);
            expect(joined.dataValidations).toEqual(next.sheets[0].dataValidations);
        };

        test('a paste lands its cells, and the rule keeps the ranges it had', () => {
            const v = { ranges: [{ row: [0, 0], column: [0, 0] }], rule: rule(0, 0) };
            const base = capCtx({ v });
            const { next, ops } = paste(base, area(rows - 1, 2));
            expect(next.sheets[0].data?.[0]?.[2]?.v).toBe('a');
            expect(next.warnDialog).toBeUndefined();
            expect(next.sheets[0].dataValidations).toEqual({ v });
            expectEveryReaderAgrees(base, next, ops);
        });

        test('a paste that would split a rule past the cap lands, and the rule goes', () => {
            const base = capCtx({ wide: { ranges: atCap, rule: rule(1, 1) } });
            const { next, ops } = paste(base, area(3, 2));
            expect(next.sheets[0].data?.[0]?.[2]?.v).toBe('a');
            expect(next.sheets[0].dataValidations).toEqual({});
            expectEveryReaderAgrees(base, next, ops);
        });
    });

    test('a move takes the rule along on its sheet', () => {
        const ctx = rangesCtx();
        move(ctx);
        const { column } = sheet(ctx).dataValidations ?? {};
        expect(column?.ranges).toEqual([{ row: [6, 9], column: [6, 6] }]);
        expect(validationAt(sheet(ctx).dataValidations, 7, 7)).toBeUndefined();
    });
});

// Merges column A from row first to row last, in place of A3:A4.
function mergeColumnA(ctx: Context, first: number, last: number) {
    const s = sheet(ctx);
    const merge = s.config?.merge ?? {};
    delete merge[key(2, 0)];
    merge[key(first, 0)] = { r: first, c: 0, rs: last - first + 1, cs: 1 };
    for (let r = 0; r < 4; r += 1) {
        const row = s.data?.[r];
        if (!row) continue;
        if (r === first) row[0] = { ...cellAt(r, 0), mc: { r, c: 0, rs: last - first + 1, cs: 1 } };
        else if (r > first && r <= last) row[0] = { mc: { r: first, c: 0 } };
        else row[0] = cellAt(r, 0);
    }
}

// The grid a browser lays the clipboard table out on: each td's text at its first slot, and '' where a span covers.
function tableGrid(html: string): string[][] {
    const grid: string[][] = [];
    for (const [i, tr] of (html.match(/<tr>.*?<\/tr>/g) ?? []).entries()) {
        grid[i] ??= [];
        let j = 0;
        for (const [, attributes, text] of tr.matchAll(/<td([^>]*)>(.*?)<\/td>/g)) {
            while (grid[i][j] != null) j += 1;
            const rs = Number(/rowspan="(\d+)"/.exec(attributes)?.[1] ?? 1);
            const cs = Number(/colspan="(\d+)"/.exec(attributes)?.[1] ?? 1);
            for (let a = 0; a < rs; a += 1) {
                for (let b = 0; b < cs; b += 1) (grid[i + a] ??= [])[j + b] = a === 0 && b === 0 ? text : '';
            }
            j += cs;
        }
    }
    return grid;
}
