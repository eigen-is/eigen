// Drag-fill number-format handling (SHEETS-TODO group 1). Pins the decided
// Excel/Google-parity contract: a dragged formula cell keeps its number format
// in ALL four directions, and the display string renders through that format's
// mask instead of an auto-detected one.
//
// Entry point: dragFill, which drags the fill handle as a person does; results land in
// ctx.sheets[0].data (getFlowdata identity).

import { describe, expect, it } from 'bun:test';
import { applyPatches, enablePatches, produceWithPatches } from 'immer';
import { parseCellInput } from '../../../engine/format';
import type { Context } from '../../../state/context';
import { setCellValue } from '../../../state/modules/cell';
import { fillFromEdge, onDropCellSelectEnd } from '../../../state/modules/drop-cell';
import { execFunctionGroup } from '../../../state/modules/formula-exec';
import { validationAt } from '../../../state/modules/validation-rules';
import type { Cell, DataValidationRule, SingleRange } from '../../../state/types';
import { filterPatch } from '../../../state/utils/patch';
import { contextFactory, heldGraph } from '../factories/context';
import { dragFill } from '../factories/grid-dom';

enablePatches();

function grid(rows: number, cols: number): (Cell | null)[][] {
    return Array.from({ length: rows }, () => Array.from({ length: cols }, () => null));
}

// Single-sheet ctx with a seeded grid; selection anchored at the source cell.
function makeCtx(seed: (d: (Cell | null)[][]) => void, selection: SingleRange): Context {
    const data = grid(8, 8);
    seed(data);
    return contextFactory({
        currentSheetId: 'id_1',
        selections: [{ ...selection, row_focus: selection.row[0], column_focus: selection.column[0] }],
        sheets: [{ name: 'sheet', id: 'id_1', order: 0, data }],
    }) as Context;
}

// A formula cell (=5/2 -> 2.5) carrying an explicit two-decimal mask.
function maskedFormula(): Cell {
    return { f: '=5/2', v: 2.5, m: '2.5', ct: { fa: '##0.00', t: 'n' } };
}

describe('drag-fill keeps the number format in every direction', () => {
    it('fills RIGHT and renders 2.5 through the ##0.00 mask, keeping the format', () => {
        const src: SingleRange = { row: [0, 0], column: [0, 0] };
        const ctx = makeCtx((d) => {
            d[0][0] = maskedFormula();
        }, src);

        dragFill(ctx, src, { row: [0, 0], column: [1, 1] }, 'right');

        const filled = ctx.sheets[0].data![0][1]!;
        expect(filled.ct?.fa).toBe('##0.00');
        expect(filled.m).toBe('2.50');
    });

    it('fills DOWN with a clean masked display (not the "2.5.00" garbage)', () => {
        const src: SingleRange = { row: [0, 0], column: [0, 0] };
        const ctx = makeCtx((d) => {
            d[0][0] = maskedFormula();
        }, src);

        dragFill(ctx, src, { row: [1, 1], column: [0, 0] }, 'down');

        const filled = ctx.sheets[0].data![1][0]!;
        expect(filled.ct?.fa).toBe('##0.00');
        expect(filled.m).toBe('2.50');
    });

    it('fills UP and keeps the format (previously clobbered to General)', () => {
        const src: SingleRange = { row: [2, 2], column: [2, 2] };
        const ctx = makeCtx((d) => {
            d[2][2] = maskedFormula();
        }, src);

        dragFill(ctx, src, { row: [1, 1], column: [2, 2] }, 'up');

        const filled = ctx.sheets[0].data![1][2]!;
        expect(filled.ct?.fa).toBe('##0.00');
        expect(filled.m).toBe('2.50');
    });

    it('fills LEFT and keeps the format (previously clobbered to General)', () => {
        const src: SingleRange = { row: [2, 2], column: [2, 2] };
        const ctx = makeCtx((d) => {
            d[2][2] = maskedFormula();
        }, src);

        dragFill(ctx, src, { row: [2, 2], column: [1, 1] }, 'left');

        const filled = ctx.sheets[0].data![2][1]!;
        expect(filled.ct?.fa).toBe('##0.00');
        expect(filled.m).toBe('2.50');
    });

    it('leaves a plain General numeric formula cell untouched (guard)', () => {
        const src: SingleRange = { row: [0, 0], column: [0, 0] };
        const ctx = makeCtx((d) => {
            d[0][0] = { f: '=5/2', v: 2.5, m: '2.5', ct: { fa: 'General', t: 'n' } };
        }, src);

        dragFill(ctx, src, { row: [1, 1], column: [0, 0] }, 'down');

        const filled = ctx.sheets[0].data![1][0]!;
        expect(filled.ct?.fa).toBe('General');
        expect(filled.m).toBe('2.5');
    });
});

// The fill also carries the source cell's borders. The fill once built those entries on a
// cloneDeep of the config and dropped the clone on the floor, so dragging a bordered cell
// produced no border at all. Driven through produceWithPatches so a write that never lands
// on the sheet shows up as a missing entry rather than an aliased one.
describe('drag-fill carries the source cell borders', () => {
    const SIDE = { style: 1, color: '#000' };
    const sourceBorder = { l: SIDE, r: SIDE, t: SIDE, b: SIDE };

    function borderedContext(): Context {
        const src: SingleRange = { row: [0, 0], column: [0, 0] };
        const ctx = makeCtx((d) => {
            d[0][0] = { v: 1, m: '1', ct: { fa: 'General', t: 'n' } };
        }, src);
        ctx.sheets[0].config = { borderInfo: { '0_0': sourceBorder } };
        return ctx;
    }

    it('lands the carried border on the sheet config', () => {
        const [filled] = produceWithPatches(borderedContext(), (ctx: Context) => {
            dragFill(ctx, { row: [0, 0], column: [0, 0] }, { row: [1, 1], column: [0, 0] }, 'down');
        });

        expect(filled.sheets[0].config!.borderInfo).toEqual({ '0_0': sourceBorder, '1_0': sourceBorder });
    });

    it('a hidden source row is filled with its border, like its value', () => {
        const src: SingleRange = { row: [0, 1], column: [0, 0] };
        const ctx = makeCtx((d) => {
            d[0][0] = { v: 'a', m: 'a' };
            d[1][0] = { v: 'b', m: 'b' };
        }, src);
        ctx.sheets[0].config = { rowhidden: { 1: 0 }, borderInfo: { '1_0': sourceBorder } };
        const [filled] = produceWithPatches(ctx, (draft: Context) => {
            dragFill(draft, src, { row: [2, 3], column: [0, 0] }, 'down');
        });

        expect(filled.sheets[0].data![3][0]?.v).toBe('b');
        expect(filled.sheets[0].config!.borderInfo).toEqual({ '1_0': sourceBorder, '3_0': sourceBorder });
    });

    it('clears a filled cell whose source has no border', () => {
        const src: SingleRange = { row: [0, 0], column: [0, 0] };
        const ctx = makeCtx((d) => {
            d[0][0] = { v: 1, m: '1', ct: { fa: 'General', t: 'n' } };
        }, src);
        ctx.sheets[0].config = { borderInfo: { '1_0': sourceBorder } };
        const [filled] = produceWithPatches(ctx, (draft: Context) => {
            dragFill(draft, { row: [0, 0], column: [0, 0] }, { row: [1, 1], column: [0, 0] }, 'down');
        });

        expect(filled.sheets[0].config!.borderInfo).toEqual({});
    });
});

// Validation rules ride along with the fill in Excel and Google Sheets. The fill once
// carried them on a cloneDeep of the sheet's rules and never wrote the clone
// back, so a dragged cell arrived with no rule — the same dead-clone shape the borders
// above had. Source and apply ranges are disjoint by construction (onDropCellSelectEnd
// starts the apply range one row/column past the copy block), so writing the live map
// while reading it cannot re-read a just-filled entry.
describe('drag-fill carries the source cell data validation', () => {
    const rule: DataValidationRule = {
        type: 'dropdown',
        type2: '',
        value1: 'yes,no',
        value2: '',
        prohibitInput: false,
        hintShow: false,
        hintValue: '',
    };

    function verifiedContext(): Context {
        const src: SingleRange = { row: [0, 0], column: [0, 0] };
        const ctx = makeCtx((d) => {
            d[0][0] = { v: 'yes', m: 'yes', ct: { fa: 'General', t: 'g' } };
        }, src);
        ctx.sheets[0].dataValidations = { v: { ranges: [{ row: [0, 0], column: [0, 0] }], order: 'a0', rule } };
        return ctx;
    }

    it('lands the rule on every filled cell, joined to the range it repeats', () => {
        const [filled] = produceWithPatches(verifiedContext(), (ctx: Context) => {
            dragFill(ctx, { row: [0, 0], column: [0, 0] }, { row: [1, 2], column: [0, 0] }, 'down');
        });

        expect(filled.sheets[0].dataValidations).toEqual({
            v: { ranges: [{ row: [0, 2], column: [0, 0] }], order: 'a0', rule },
        });
    });

    it('and the patch that survives filterPatch carries it, so peers and undo see it', () => {
        const base = verifiedContext();
        const [, patches] = produceWithPatches(base, (ctx: Context) => {
            dragFill(ctx, { row: [0, 0], column: [0, 0] }, { row: [1, 1], column: [0, 0] }, 'down');
        });

        const synced = applyPatches(base, filterPatch(patches));
        expect(validationAt(synced.sheets[0].dataValidations, 1, 0)).toEqual(rule);
    });

    // Every filled cell looked its source's rule up again, through every rule on the sheet: 108 s here.
    it('a fill down 10,000 rows on a sheet of 1,000 rules looks each source cell up once', () => {
        const rows = 10_000;
        const ctx = contextFactory({
            currentSheetId: 'id_1',
            selections: [{ row: [0, 0], column: [0, 0], row_focus: 0, column_focus: 0 }],
            sheets: [{ name: 'sheet', id: 'id_1', order: 0, data: grid(rows, 4) }],
        }) as Context;
        const elsewhere = Array.from({ length: 1000 }, (_, k) => [
            `r${k}`,
            { ranges: Array.from({ length: 8 }, (_, i) => ({ row: [k * 8 + i, k * 8 + i], column: [3, 3] })), rule },
        ]);
        ctx.sheets[0].dataValidations = {
            ...Object.fromEntries(elsewhere),
            v: { ranges: [{ row: [0, 0], column: [0, 0] }], order: 'a0', rule },
        };
        const started = performance.now();
        const [filled] = produceWithPatches(ctx, (draft: Context) => {
            dragFill(draft, { row: [0, 0], column: [0, 0] }, { row: [1, rows - 1], column: [0, 0] }, 'down');
        });
        expect(performance.now() - started).toBeLessThan(5000);
        expect(filled.sheets[0].dataValidations?.v.ranges).toEqual([{ row: [0, rows - 1], column: [0, 0] }]);
    });

    it('a filled cell takes the rule of the cell it repeats, and one whose source has none loses its own', () => {
        const other: DataValidationRule = { ...rule, value1: 'a,b' };
        const ctx = makeCtx(() => {}, { row: [0, 1], column: [0, 1] });
        ctx.sheets[0].dataValidations = {
            v: { ranges: [{ row: [0, 0], column: [0, 1] }], order: 'a0', rule },
            own: { ranges: [{ row: [2, 5], column: [0, 1] }], order: 'a0', rule: other },
        };
        const [filled] = produceWithPatches(ctx, (draft: Context) => {
            dragFill(draft, { row: [0, 1], column: [0, 1] }, { row: [2, 5], column: [0, 1] }, 'down');
        });
        const rules = filled.sheets[0].dataValidations;
        for (let r = 2; r <= 5; r += 1) {
            for (let c = 0; c <= 1; c += 1) expect(validationAt(rules, r, c)).toEqual(r % 2 === 0 ? rule : undefined);
        }
        expect(rules?.v.ranges).toEqual([
            { row: [0, 0], column: [0, 1] },
            { row: [2, 2], column: [0, 1] },
            { row: [4, 4], column: [0, 1] },
        ]);
        expect(rules?.own).toBeUndefined();
    });
});

// Excel: A1 =B1 and A2 =B2 dragged down to A3:A6 give =B3..=B6, each cell shifted by its
// distance from the source cell it repeats.
describe('drag-fill shifts a formula block by the distance to its source cell', () => {
    const formula = (f: string): Cell => ({ f, v: 0, m: '0', ct: { fa: 'General', t: 'n' } });

    function fill(
        seed: Record<string, Cell>,
        src: SingleRange,
        apply: SingleRange,
        direction: 'down' | 'up' | 'right' | 'left',
    ) {
        const ctx = makeCtx((d) => {
            for (const [key, cell] of Object.entries(seed)) {
                const [r, c] = key.split('_').map(Number);
                d[r][c] = cell;
            }
        }, src);
        dragFill(ctx, src, apply, direction);
        return ctx.sheets[0].data!;
    }

    it('fills DOWN', () => {
        const src: SingleRange = { row: [0, 1], column: [0, 0] };
        const d = fill({ '0_0': formula('=B1'), '1_0': formula('=B2') }, src, { row: [2, 5], column: [0, 0] }, 'down');
        expect([2, 3, 4, 5].map((r) => d[r][0]?.f)).toEqual(['=B3', '=B4', '=B5', '=B6']);
    });

    it('fills UP', () => {
        const src: SingleRange = { row: [6, 7], column: [0, 0] };
        const d = fill({ '6_0': formula('=B7'), '7_0': formula('=B8') }, src, { row: [2, 5], column: [0, 0] }, 'up');
        expect([2, 3, 4, 5].map((r) => d[r][0]?.f)).toEqual(['=B3', '=B4', '=B5', '=B6']);
    });

    it('fills RIGHT', () => {
        const src: SingleRange = { row: [0, 0], column: [0, 1] };
        const d = fill({ '0_0': formula('=A3'), '0_1': formula('=B3') }, src, { row: [0, 0], column: [2, 5] }, 'right');
        expect([2, 3, 4, 5].map((c) => d[0][c]?.f)).toEqual(['=C3', '=D3', '=E3', '=F3']);
    });

    it('fills LEFT', () => {
        const src: SingleRange = { row: [0, 0], column: [6, 7] };
        const d = fill({ '0_6': formula('=G3'), '0_7': formula('=H3') }, src, { row: [0, 0], column: [2, 5] }, 'left');
        expect([2, 3, 4, 5].map((c) => d[0][c]?.f)).toEqual(['=C3', '=D3', '=E3', '=F3']);
    });

    it('fills a block mixing formula and number cells', () => {
        const src: SingleRange = { row: [0, 2], column: [0, 0] };
        const seed = {
            '0_0': formula('=B1'),
            '1_0': { v: 5, m: '5', ct: { fa: 'General', t: 'n' } },
            '2_0': formula('=B3'),
        };
        const d = fill(seed, src, { row: [3, 7], column: [0, 0] }, 'down');
        expect([3, 5, 6].map((r) => d[r][0]?.f)).toEqual(['=B4', '=B6', '=B7']);
        expect([4, 7].map((r) => d[r][0]?.v)).toEqual([5, 5]);
    });
});

// Excel refuses a fill that would split or overwrite a merge; every fill door bails the same way.
describe('a fill touching a merge changes nothing', () => {
    type Merge = { r: number; c: number; rs: number; cs: number };

    function mergedContext(merge: Merge, selection: SingleRange) {
        const ctx = makeCtx((d) => {
            for (let r = 0; r < 3; r += 1) {
                for (let c = 0; c < 3; c += 1) d[r][c] = { v: r * 10 + c, m: `${r * 10 + c}` };
            }
            for (let r = merge.r; r < merge.r + merge.rs; r += 1) {
                for (let c = merge.c; c < merge.c + merge.cs; c += 1) {
                    d[r][c] = { ...d[r][c], mc: r === merge.r && c === merge.c ? merge : { r: merge.r, c: merge.c } };
                }
            }
        }, selection);
        ctx.sheets[0].config = { merge: { [`${merge.r}_${merge.c}`]: merge } };
        return ctx;
    }

    function expectUnchanged(ctx: Context, fill: (ctx: Context) => void) {
        const before = structuredClone(ctx.sheets[0]);
        fill(ctx);
        expect(ctx.sheets[0].data).toEqual(before.data);
        expect(ctx.sheets[0].config).toEqual(before.config);
    }

    const cases: { name: string; merge: Merge; direction: 'down' | 'right' }[] = [
        { name: 'Ctrl+D with a merged top row', merge: { r: 0, c: 0, rs: 1, cs: 2 }, direction: 'down' },
        { name: 'Ctrl+D with a merge in the filled rows', merge: { r: 1, c: 0, rs: 1, cs: 2 }, direction: 'down' },
        { name: 'Ctrl+R with a merged left column', merge: { r: 0, c: 0, rs: 2, cs: 1 }, direction: 'right' },
        { name: 'Ctrl+R with a merge in the filled columns', merge: { r: 0, c: 1, rs: 2, cs: 1 }, direction: 'right' },
    ];

    for (const { name, merge, direction } of cases) {
        it(name, () => {
            const range: SingleRange = { row: [0, 2], column: [0, 2] };
            expectUnchanged(mergedContext(merge, range), (ctx) => fillFromEdge(ctx, range, direction));
        });
    }

    // Drags the fill handle from A1 down to row 3 (y = 50 lands in the third 20px row).
    function dragDown(ctx: Context) {
        ctx.cellSelectExtendIndex = [0, 0];
        ctx.selections = [
            { row: [0, 0], column: [0, 0], row_focus: 0, column_focus: 0, top: 0, left: 0, height: 19, width: 73 },
        ];
        const cellArea = {
            getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 600 }),
            scrollLeft: 0,
            scrollTop: 0,
        } as unknown as HTMLDivElement;
        const container = { querySelectorAll: () => [] } as unknown as HTMLDivElement;
        onDropCellSelectEnd(ctx, { clientX: 10, clientY: 50 } as MouseEvent, cellArea, container);
    }

    it('the fill-handle drag over a merge', () => {
        expectUnchanged(mergedContext({ r: 1, c: 0, rs: 1, cs: 2 }, { row: [0, 0], column: [0, 0] }), dragDown);
    });

    it('the fill-handle drag without a merge still fills', () => {
        const ctx = makeCtx(
            (d) => {
                d[0][0] = { v: 'x', m: 'x' };
            },
            { row: [0, 0], column: [0, 0] },
        );
        dragDown(ctx);
        expect([1, 2].map((r) => ctx.sheets[0].data![r][0]?.v)).toEqual(['x', 'x']);
    });
});

describe('a filled formula', () => {
    it('keeps its text result as text', () => {
        const src: SingleRange = { row: [0, 0], column: [1, 1] };
        const ctx = makeCtx((d) => {
            d[0][0] = { v: 7, m: '7', ct: { fa: 'General', t: 'n' } };
            d[1][0] = { v: 8, m: '8', ct: { fa: 'General', t: 'n' } };
            d[0][1] = { f: '=TEXT(A1,"000")', v: '007', m: '007', ct: { fa: 'General', t: 'g' } };
        }, src);

        dragFill(ctx, src, { row: [1, 1], column: [1, 1] }, 'down');

        const filled = ctx.sheets[0].data![1][1]!;
        expect([filled.v, filled.m]).toEqual(['008', '008']);
    });

    it('a fill of a formula this build cannot evaluate has no number to keep, and its source keeps its own', () => {
        const src: SingleRange = { row: [0, 0], column: [1, 1] };
        const ctx = makeCtx((d) => {
            d[0][1] = { f: '=FILTER(A1,1)', v: 111, m: '111' };
        }, src);

        dragFill(ctx, src, { row: [1, 1], column: [1, 1] }, 'down');

        expect(ctx.sheets[0].data![0][1]?.v).toBe(111);
        expect(ctx.sheets[0].data![1][1]?.v).toBe('#NAME?');
    });

    it('recalcs when its precedent changes', () => {
        const src: SingleRange = { row: [0, 0], column: [1, 1] };
        const ctx = makeCtx((d) => {
            for (let r = 0; r < 3; r += 1) d[r][0] = { v: r + 1, m: `${r + 1}` };
            d[0][1] = { f: '=A1*2', v: 2, m: '2' };
        }, src);
        heldGraph(ctx);

        dragFill(ctx, src, { row: [1, 2], column: [1, 1] }, 'down');
        setCellValue(ctx, 2, 0, ctx.sheets[0].data, 10);
        execFunctionGroup(ctx, [{ r: 2, c: 0, id: 'id_1' }]);

        expect(ctx.sheets[0].data![2][1]?.v).toBe(20);
    });
});

describe('a fill counts on from what its source holds', () => {
    type Direction = 'down' | 'up' | 'right' | 'left';
    const number = (v: number, bg?: string): Cell => ({ v, m: `${v}`, ct: { fa: 'General', t: 'n' }, bg });
    const text = (v: string): Cell => ({ v, m: v, ct: { fa: 'General', t: 'g' } });
    const date = (iso: string, fa = 'yyyy-MM-dd', m = iso, bg?: string): Cell => ({
        v: parseCellInput(iso)[2],
        m,
        ct: { fa, t: 'd' },
        bg,
    });

    // Lays `source` along the fill's axis, in sheet order, and returns what lands in the `count` cells beside it,
    // nearest the source first.
    function filled(source: (Cell | null)[], count: number, direction: Direction, hide?: (ctx: Context) => void) {
        const backward = direction === 'up' || direction === 'left';
        const vertical = direction === 'up' || direction === 'down';
        const first = backward ? count : 0;
        const last = first + source.length - 1;
        const along = (a: number, b: number): SingleRange =>
            vertical ? { row: [a, b], column: [0, 0] } : { row: [0, 0], column: [a, b] };
        const ctx = makeCtx(
            (d) => {
                for (const [i, cell] of source.entries()) {
                    if (vertical) d[first + i][0] = cell;
                    else d[0][first + i] = cell;
                }
            },
            along(first, last),
        );
        hide?.(ctx);
        dragFill(ctx, along(first, last), backward ? along(0, first - 1) : along(last + 1, last + count), direction);
        return Array.from({ length: count }, (_, i) => {
            const at = backward ? first - 1 - i : last + 1 + i;
            return vertical ? ctx.sheets[0].data?.[at][0] : ctx.sheets[0].data?.[0][at];
        });
    }
    const shown = (cells: ReturnType<typeof filled>) => cells.map((cell) => cell?.m ?? null);

    const series: { name: string; source: Cell[]; direction: Direction; expected: string[] }[] = [
        { name: 'numbers down', source: [number(1), number(2)], direction: 'down', expected: ['3', '4', '5'] },
        { name: 'numbers up', source: [number(1), number(2)], direction: 'up', expected: ['0', '-1', '-2'] },
        { name: 'numbers right', source: [number(1), number(2)], direction: 'right', expected: ['3', '4', '5'] },
        { name: 'numbers left', source: [number(1), number(2)], direction: 'left', expected: ['0', '-1', '-2'] },
        {
            name: 'falling numbers down',
            source: [number(5), number(3)],
            direction: 'down',
            expected: ['1', '-1', '-3'],
        },
        { name: 'falling numbers up', source: [number(5), number(3)], direction: 'up', expected: ['7', '9', '11'] },
        {
            name: 'a trend through uneven numbers',
            source: [number(1), number(2), number(4)],
            direction: 'down',
            expected: ['5.33333', '6.83333', '8.33333'],
        },
        {
            name: 'doubling numbers as a line',
            source: [number(1), number(2), number(4), number(8)],
            direction: 'down',
            expected: ['9.5', '11.8', '14.1'],
        },
        {
            name: 'days down',
            source: [date('2024-01-30'), date('2024-02-01')],
            direction: 'down',
            expected: ['2024-02-03', '2024-02-05', '2024-02-07'],
        },
        {
            name: 'days up',
            source: [date('2024-01-30'), date('2024-02-01')],
            direction: 'up',
            expected: ['2024-01-28', '2024-01-26', '2024-01-24'],
        },
        {
            name: 'months down',
            source: [date('2024-01-15'), date('2024-02-15')],
            direction: 'down',
            expected: ['2024-03-15', '2024-04-15', '2024-05-15'],
        },
        {
            name: 'months up',
            source: [date('2024-01-15'), date('2024-02-15')],
            direction: 'up',
            expected: ['2023-12-15', '2023-11-15', '2023-10-15'],
        },
        {
            name: 'months left',
            source: [date('2024-01-15'), date('2024-02-15')],
            direction: 'left',
            expected: ['2023-12-15', '2023-11-15', '2023-10-15'],
        },
        {
            name: 'falling months down',
            source: [date('2024-03-15'), date('2024-02-15')],
            direction: 'down',
            expected: ['2024-01-15', '2023-12-15', '2023-11-15'],
        },
        {
            name: 'a year as twelve months',
            source: [date('2024-01-15'), date('2025-01-15')],
            direction: 'down',
            expected: ['2026-01-15', '2027-01-15', '2028-01-15'],
        },
        {
            name: 'months past a short month, from the last source date',
            source: [date('2023-12-31'), date('2024-01-31')],
            direction: 'down',
            expected: ['2024-02-29', '2024-03-31', '2024-04-30'],
        },
        {
            name: 'text down',
            source: [text('Item 1'), text('Item 2')],
            direction: 'down',
            expected: ['Item 3', 'Item 4', 'Item 5'],
        },
        {
            name: 'text keeps the width of a number with leading zeros',
            source: [text('Item 007'), text('Item 008')],
            direction: 'down',
            expected: ['Item 009', 'Item 010', 'Item 011'],
        },
        {
            name: 'text under a number format counts as text',
            source: [
                { v: 'x1', m: 'x1', ct: { fa: '0', t: 'n' } },
                { v: 'x2', m: 'x2', ct: { fa: '0', t: 'n' } },
            ],
            direction: 'down',
            expected: ['x3', 'x4', 'x5'],
        },
        {
            name: 'text past nine grows without a leading zero',
            source: [text('Item 8'), text('Item 9')],
            direction: 'down',
            expected: ['Item 10', 'Item 11', 'Item 12'],
        },
        {
            name: 'text up, past zero',
            source: [text('Item 2'), text('Item 3')],
            direction: 'up',
            expected: ['Item 1', 'Item 0', 'Item 1'],
        },
        {
            name: 'text right',
            source: [text('Item 1'), text('Item 2')],
            direction: 'right',
            expected: ['Item 3', 'Item 4', 'Item 5'],
        },
        {
            name: 'falling text down',
            source: [text('Item 9'), text('Item 7')],
            direction: 'down',
            expected: ['Item 5', 'Item 3', 'Item 1'],
        },
        {
            name: 'falling text left',
            source: [text('Item 7'), text('Item 9')],
            direction: 'left',
            expected: ['Item 5', 'Item 3', 'Item 1'],
        },
        {
            name: 'the last number of a text, wherever it sits',
            source: [text('Q1 of 2024 report'), text('Q1 of 2025 report')],
            direction: 'down',
            expected: ['Q1 of 2026 report', 'Q1 of 2027 report', 'Q1 of 2028 report'],
        },
    ];
    for (const { name, source, direction, expected } of series) {
        it(`counts ${name}`, () => {
            expect(shown(filled(source, 3, direction))).toEqual(expected);
        });
    }

    it('counts one text ending in a number, down and up, and keeps its width', () => {
        expect(shown(filled([text('Item 1')], 3, 'down'))).toEqual(['Item 2', 'Item 3', 'Item 4']);
        expect(shown(filled([text('Item 5')], 2, 'up'))).toEqual(['Item 4', 'Item 3']);
        expect(shown(filled([text('Item 5')], 2, 'left'))).toEqual(['Item 4', 'Item 3']);
        expect(shown(filled([text('Item 007')], 1, 'right'))).toEqual(['Item 008']);
    });

    it('counts on from one text ending in a number that a number format left as text', () => {
        const numbered = (v: string): Cell => ({ v, m: v, ct: { fa: '##0.00', t: 'n' } });
        expect(shown(filled([numbered('x1')], 2, 'down'))).toEqual(['x2', 'x3']);
        expect(shown(filled([numbered('12')], 2, 'down'))).toEqual(['12', '12']);
    });

    it('fill down copies one text ending in a number', () => {
        const range: SingleRange = { row: [0, 1], column: [0, 0] };
        const ctx = makeCtx((d) => {
            d[0][0] = text('Item 1');
        }, range);
        fillFromEdge(ctx, range, 'down');
        expect(ctx.sheets[0].data?.[1][0]?.m).toBe('Item 1');
    });

    const copies: { name: string; source: (Cell | null)[] }[] = [
        { name: 'one number', source: [number(7)] },
        { name: 'one date', source: [date('2024-01-15')] },
        { name: 'one text with a number inside it', source: [text('Item 1 of 3 left')] },
        { name: 'one number with no type', source: [{ v: 5, m: '5' }] },
        { name: 'dates at uneven days', source: [date('2024-01-01'), date('2024-01-02'), date('2024-01-05')] },
        { name: 'dates at uneven months', source: [date('2024-01-01'), date('2024-02-01'), date('2024-04-01')] },
        { name: 'one date twice', source: [date('2024-01-15'), date('2024-01-15')] },
        { name: 'text at uneven numbers', source: [text('Item 1'), text('Item 2'), text('Item 4')] },
        { name: 'numbers in different words', source: [text('a1'), text('b2')] },
        { name: 'plain words', source: [text('yes'), text('no')] },
        { name: 'kinds side by side', source: [number(1), text('a'), number(3)] },
        { name: 'a gap between numbers', source: [number(1), null, number(3)] },
        { name: 'empty text', source: [text(''), text('')] },
        { name: 'Chinese numerals', source: [text('一'), text('二')] },
        { name: 'Chinese day names', source: [text('周一'), text('周二')] },
        { name: 'long Chinese day names', source: [text('星期一'), text('星期二')] },
        { name: 'the Chinese Sunday', source: [text('六'), text('日')] },
    ];
    for (const { name, source } of copies) {
        it(`copies ${name} down, and mirrored up`, () => {
            const count = source.length + 1;
            const m = source.map((cell) => cell?.m ?? null);
            expect(shown(filled(source, count, 'down'))).toEqual([...m, m[0]]);
            const mirrored = [...m].reverse();
            expect(shown(filled(source, count, 'up'))).toEqual([...mirrored, mirrored[0]]);
        });
    }

    it('counts a numeric run and copies the words beside it, each repeating its source place', () => {
        const source = [number(1), number(2), text('a')];
        expect(shown(filled(source, 5, 'down'))).toEqual(['3', '4', 'a', '5', '6']);
    });

    // The cell beside the source repeats the source's nearest cell: 'a' above a block that starts 1, 2, a.
    it('dragged up, a mixed block repeats from its nearest cell', () => {
        const source = [number(1), number(2), text('a')];
        expect(shown(filled(source, 5, 'up'))).toEqual(['a', '0', '-1', 'a', '-2']);
    });

    it('dragged up, a formula in a mixed block shifts by the distance to the cell it repeats', () => {
        const src: SingleRange = { row: [6, 7], column: [0, 0] };
        const ctx = makeCtx((d) => {
            d[6][0] = { f: '=B7', v: 0, m: '0', ct: { fa: 'General', t: 'n' } };
            d[7][0] = number(5);
        }, src);
        dragFill(ctx, src, { row: [4, 5], column: [0, 0] }, 'up');
        const d = ctx.sheets[0].data;
        expect(d?.[5][0]?.v).toBe(5);
        expect(d?.[4][0]?.f).toBe('=B5');
    });

    it('keeps the format of the source cell it repeats, down and up', () => {
        const source = [number(1, '#f00'), number(2, '#00f')];
        expect(filled(source, 2, 'down').map((cell) => cell?.bg)).toEqual(['#f00', '#00f']);
        expect(filled(source, 2, 'up').map((cell) => cell?.bg)).toEqual(['#00f', '#f00']);
    });

    it('a date series keeps the format of the source cell it repeats', () => {
        const source = [
            date('2024-01-15', 'yyyy-MM-dd', '2024-01-15', '#f00'),
            date('2024-02-15', 'yyyy-MM-dd', '2024-02-15', '#00f'),
        ];
        expect(filled(source, 2, 'down').map((cell) => cell?.bg)).toEqual(['#f00', '#00f']);
    });

    it('renders a series through the number format of its source', () => {
        const masked = (v: number): Cell => ({ v, m: v.toFixed(2), ct: { fa: '##0.00', t: 'n' } });
        expect(shown(filled([masked(1), masked(2)], 2, 'down'))).toEqual(['3.00', '4.00']);
    });

    // 01/02 and 02/02 are a day apart, whatever a date parser makes of the text.
    it('a date shown day first counts by its value, not its text', () => {
        const source = [date('2024-02-01', 'dd/MM/yyyy', '01/02/2024'), date('2024-02-02', 'dd/MM/yyyy', '02/02/2024')];
        expect(shown(filled(source, 2, 'down'))).toEqual(['03/02/2024', '04/02/2024']);
    });

    it('a hidden row keeps its cell and still takes a step of the series', () => {
        const cells = filled([number(1), number(2)], 3, 'down', (ctx) => {
            ctx.sheets[0].config = { rowhidden: { 3: 0 } };
        });
        expect(shown(cells)).toEqual(['3', null, '5']);
    });

    it('a hidden column in a downward fill keeps its cells', () => {
        const src: SingleRange = { row: [0, 1], column: [0, 1] };
        const ctx = makeCtx((d) => {
            d[0][0] = number(1);
            d[1][0] = number(2);
            d[0][1] = number(10);
            d[1][1] = number(20);
        }, src);
        ctx.sheets[0].config = { colhidden: { 0: 0 } };
        dragFill(ctx, src, { row: [2, 3], column: [0, 1] }, 'down');
        const d = ctx.sheets[0].data;
        expect([d?.[2][0], d?.[3][0]]).toEqual([null, null]);
        expect([d?.[2][1]?.v, d?.[3][1]?.v]).toEqual([30, 40]);
    });

    it('each column of a block counts on its own', () => {
        const src: SingleRange = { row: [0, 1], column: [0, 1] };
        const ctx = makeCtx((d) => {
            d[0][0] = number(1);
            d[1][0] = number(2);
            d[0][1] = text('Item 5');
            d[1][1] = text('Item 10');
        }, src);
        dragFill(ctx, src, { row: [2, 3], column: [0, 1] }, 'down');
        const d = ctx.sheets[0].data;
        expect([d?.[2][0]?.m, d?.[3][0]?.m, d?.[2][1]?.m, d?.[3][1]?.m]).toEqual(['3', '4', 'Item 15', 'Item 20']);
    });

    it('fill down copies the top row, numbers included, and fill right the left column', () => {
        const seed = (d: (Cell | null)[][]) => {
            d[0][0] = number(1);
            d[0][1] = number(2);
            d[1][0] = number(3);
        };
        const range: SingleRange = { row: [0, 2], column: [0, 1] };
        const down = makeCtx(seed, range);
        fillFromEdge(down, range, 'down');
        expect([1, 2].map((r) => down.sheets[0].data?.[r].slice(0, 2).map((cell) => cell?.v))).toEqual([
            [1, 2],
            [1, 2],
        ]);
        const right = makeCtx(seed, range);
        fillFromEdge(right, range, 'right');
        expect(right.sheets[0].data?.[0][1]?.v).toBe(1);
        expect(right.sheets[0].data?.[1][1]?.v).toBe(3);
    });

    // Rows are 20px. Drags the handle of A5:A6 to the row under clientY.
    function dragTo(clientY: number) {
        const ctx = makeCtx(
            (d) => {
                d[4][0] = number(1);
                d[5][0] = number(2);
            },
            { row: [4, 5], column: [0, 0] },
        );
        ctx.visibledatarow = [20, 40, 60, 80, 100, 120, 140, 160];
        ctx.cellSelectExtendIndex = [5, 0];
        ctx.selections = [
            {
                row: [4, 5],
                column: [0, 0],
                row_focus: 4,
                column_focus: 0,
                top: 80,
                left: 0,
                height: 39,
                width: 73,
                top_move: 80,
                left_move: 0,
                height_move: 39,
                width_move: 73,
            },
        ];
        const cellArea = {
            getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 600 }),
            scrollLeft: 0,
            scrollTop: 0,
        } as unknown as HTMLDivElement;
        const container = { querySelectorAll: () => [] } as unknown as HTMLDivElement;
        onDropCellSelectEnd(ctx, { clientX: 10, clientY } as MouseEvent, cellArea, container);
        return ctx;
    }

    it('the handle dragged up counts down from the top of the selection', () => {
        const ctx = dragTo(50);
        expect([3, 2].map((r) => ctx.sheets[0].data?.[r][0]?.v)).toEqual([0, -1]);
        expect(ctx.selections?.[0].row).toEqual([2, 5]);
    });

    it('the handle dragged down counts on from the bottom of the selection', () => {
        const ctx = dragTo(150);
        expect([6, 7].map((r) => ctx.sheets[0].data?.[r][0]?.v)).toEqual([3, 4]);
        expect(ctx.selections?.[0].row).toEqual([4, 7]);
    });
});
