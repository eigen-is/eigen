// Copy, cut, move and the format painter over a range with a hidden row and a hidden column inside it. As in
// Excel, the hidden cells travel with the rest: their values, formats, borders, validation, links and merges land
// at the destination, and the destination's rows and columns keep the hidden state they had. Only a copy over
// rows an active filter hides leaves those rows out, and then the side tables close up with the cells.
//
// The source block is A1:D4 with row 2 and column B hidden. Three cells carry a border, a validation rule and a
// link: A1 before the hidden lines, B2 on both of them, C3 after them. C1:D1 and A3:A4 are merged. The paste
// lands at G7, and row 9 of the destination was hidden beforehand.

import { describe, expect, test } from 'bun:test';
import type { DataVerificationRule } from '@workspace/lib/sheets';
import type { Context } from '../../state/context';
import { handleCopy } from '../../state/events/copy';
import { handlePasteByClick } from '../../state/events/paste';
import { handleCut } from '../../state/modules/clipboard';
import { onCellsMoveEnd } from '../../state/modules/move-cells';
import { pasteHandlerOfPaintModel, rangeValueToClipboard } from '../../state/modules/selection';
import { handleFormatPainter } from '../../state/modules/toolbar';
import type { Cell, GlobalCache, Selection } from '../../state/types';
import { author, join } from './factories/collab';
import { contextFactory } from './factories/context';
import { gridElements, withGridGeometry } from './factories/grid-dom';

// biome-ignore lint/suspicious/noExplicitAny: test-only globalThis injection
(globalThis as any).sessionStorage = { setItem: () => {} };

const SIZE = 12;
const SIDE = { style: 1, color: '#000' };
const MARKED = [
    [0, 0],
    [1, 1],
    [2, 2],
] as const;

function rule(r: number, c: number): DataVerificationRule {
    return {
        type: 'dropdown',
        type2: '',
        rangeTxt: '',
        value1: `list ${r}${c}`,
        value2: '',
        validity: '',
        remote: false,
        prohibitInput: false,
        hintShow: false,
        hintValue: '',
    };
}

function link(r: number, c: number) {
    return { linkType: 'webpage', linkAddress: `https://eigen.is/${r}${c}` };
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
    for (const [r, c] of MARKED) data[r][c] = { ...cellAt(r, c), hl: { r, c, id: 'id_1' } };
    const borderInfo = Object.fromEntries(MARKED.map(([r, c]) => [`${r}_${c}`, { t: SIDE, l: SIDE }]));
    const dataVerification = Object.fromEntries(MARKED.map(([r, c]) => [`${r}_${c}`, rule(r, c)]));
    const hyperlink = Object.fromEntries(MARKED.map(([r, c]) => [`${r}_${c}`, link(r, c)]));
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
                    dataVerification,
                    hyperlink,
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
    handlePasteByClick(ctx, 'internal');
}

function paint(ctx: Context) {
    handleFormatPainter(ctx);
    ctx.selections = destination();
    pasteHandlerOfPaintModel(ctx, ctx.copyState);
}

// Drags A1:D4 by its top-left cell onto G7.
function move(ctx: Context) {
    ctx.cellSelectMoving = true;
    ctx.cellSelectMoveIndex = [0, 0];
    const { container, scrollEl } = gridElements();
    const event = { pageX: 46 + 6 * 74 + 30, pageY: 20 + 6 * 20 + 10 } as MouseEvent;
    onCellsMoveEnd(ctx, {} as GlobalCache, event, scrollEl, container);
}

const sheet = (ctx: Context) => ctx.sheets[0];
const key = (r: number, c: number) => `${r}_${c}`;

// Every source cell (r, c) lands at (r + 6, c + 6), each side table with it.
function expectCarriedWhole(ctx: Context, { links = true } = {}) {
    const s = sheet(ctx);
    for (const [r, c] of MARKED) {
        expect(s.config?.borderInfo?.[key(r + 6, c + 6)]).toEqual({ t: SIDE, l: SIDE });
        expect(s.dataVerification?.[key(r + 6, c + 6)]).toEqual(rule(r, c));
        expect(s.hyperlink?.[key(r + 6, c + 6)]).toEqual(links ? link(r, c) : undefined);
    }
    // Nothing lands on the cell beside a marked one, as an index one off would.
    for (const [r, c] of [
        [6, 7],
        [7, 8],
        [8, 9],
    ]) {
        expect(s.config?.borderInfo?.[key(r, c)]).toBeUndefined();
        expect(s.dataVerification?.[key(r, c)]).toBeUndefined();
        expect(s.hyperlink?.[key(r, c)]).toBeUndefined();
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
        expect(s.dataVerification?.[key(r, c)]).toBeUndefined();
        expect(s.hyperlink?.[key(r, c)]).toBeUndefined();
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
        paste(ctx, true);
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
            pasteHandlerOfPaintModel(ctx, ctx.copyState);
        });
        expect(next.sheets[1].data?.[7][7]?.hl).toBeUndefined();
        const joined = join(base, [ops]).find((s) => s.id === 'id_2');
        expect(joined?.data?.[7][7]?.bg).toBe('#110000');
    });

    test('the clipboard carries the hidden row and column', () => {
        const ctx = makeCtx();
        const text = rangeValueToClipboard(ctx, 'id_1', source())?.cellText;
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
        expect(s.dataVerification?.[key(6, 6)]).toEqual(rule(0, 0));
        expect(s.dataVerification?.[key(7, 8)]).toEqual(rule(2, 2));
        expect(s.dataVerification?.[key(7, 7)]).toBeUndefined();
        expect(s.dataVerification?.[key(8, 8)]).toBeUndefined();
        expect(s.hyperlink?.[key(6, 6)]).toEqual(links ? link(0, 0) : undefined);
        expect(s.hyperlink?.[key(7, 8)]).toEqual(links ? link(2, 2) : undefined);
        expect(s.hyperlink?.[key(7, 7)]).toBeUndefined();
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

    test('a cut still carries the filtered row, as Excel moves every cell it cuts', () => {
        const ctx = makeCtx({ filtered: true });
        paste(ctx, true);
        expectValuesWhole(ctx);
        expectSourceCleared(ctx);
    });

    test('the clipboard leaves the filtered row out', () => {
        const ctx = makeCtx({ filtered: true });
        const text = rangeValueToClipboard(ctx, 'id_1', source())?.cellText;
        expect(text?.split('\n')).toEqual(['r0c0\tr0c1\tr0c2\t', 'r2c0\tr2c1\tr2c2\tr2c3', '\tr3c1\tr3c2\tr3c3']);
    });

    // A1:A3 has the filtered row inside it, and A2:A3 has it as its first row. Either way the table keeps its shape.
    test.each([
        [0, 2],
        [1, 2],
    ])('the clipboard table closes a merge over rows %i to %i up with the rows', (first, last) => {
        const ctx = makeCtx({ filtered: true });
        mergeColumnA(ctx, first, last);
        const html = rangeValueToClipboard(ctx, 'id_1', source())?.html ?? '';
        expect(tableGrid(html)).toEqual([
            ['r0c0', 'r0c1', 'r0c2', ''],
            ['', 'r2c1', 'r2c2', 'r2c3'],
            ['r3c0', 'r3c1', 'r3c2', 'r3c3'],
        ]);
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
