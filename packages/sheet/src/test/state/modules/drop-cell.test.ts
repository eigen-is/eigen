// Drag-fill number-format handling (SHEETS-TODO group 1). Pins the decided
// Excel/Google-parity contract: a dragged formula cell keeps its number format
// in ALL four directions, and the display string renders through that format's
// mask instead of an auto-detected one.
//
// Entry point: autoFillCell(ctx, copyRange, applyRange, direction) — the same
// door onDropCellSelectEnd uses. It primes dropCellCache and calls
// updateDropCell; results land in ctx.sheets[0].data (getFlowdata identity).

import { describe, expect, it } from 'bun:test';
import { applyPatches, enablePatches, produceWithPatches } from 'immer';
import { autoFillCell } from '../../../state/api/cell';
import type { Context } from '../../../state/context';
import { setCellValue } from '../../../state/modules/cell';
import { fillFromEdge, onDropCellSelectEnd } from '../../../state/modules/drop-cell';
import { execFunctionGroup, groupValuesRefresh, warmFormulaCellInfoMap } from '../../../state/modules/formula-exec';
import type { Cell, DataVerificationRule, SingleRange } from '../../../state/types';
import { filterPatch } from '../../../state/utils/patch';
import { contextFactory } from '../factories/context';

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

        autoFillCell(ctx, src, { row: [0, 0], column: [1, 1] }, 'right');

        const filled = ctx.sheets[0].data![0][1]!;
        expect(filled.ct?.fa).toBe('##0.00');
        expect(filled.m).toBe('2.50');
    });

    it('fills DOWN with a clean masked display (not the "2.5.00" garbage)', () => {
        const src: SingleRange = { row: [0, 0], column: [0, 0] };
        const ctx = makeCtx((d) => {
            d[0][0] = maskedFormula();
        }, src);

        autoFillCell(ctx, src, { row: [1, 1], column: [0, 0] }, 'down');

        const filled = ctx.sheets[0].data![1][0]!;
        expect(filled.ct?.fa).toBe('##0.00');
        expect(filled.m).toBe('2.50');
    });

    it('fills UP and keeps the format (previously clobbered to General)', () => {
        const src: SingleRange = { row: [2, 2], column: [2, 2] };
        const ctx = makeCtx((d) => {
            d[2][2] = maskedFormula();
        }, src);

        autoFillCell(ctx, src, { row: [1, 1], column: [2, 2] }, 'up');

        const filled = ctx.sheets[0].data![1][2]!;
        expect(filled.ct?.fa).toBe('##0.00');
        expect(filled.m).toBe('2.50');
    });

    it('fills LEFT and keeps the format (previously clobbered to General)', () => {
        const src: SingleRange = { row: [2, 2], column: [2, 2] };
        const ctx = makeCtx((d) => {
            d[2][2] = maskedFormula();
        }, src);

        autoFillCell(ctx, src, { row: [2, 2], column: [1, 1] }, 'left');

        const filled = ctx.sheets[0].data![2][1]!;
        expect(filled.ct?.fa).toBe('##0.00');
        expect(filled.m).toBe('2.50');
    });

    it('leaves a plain General numeric formula cell untouched (guard)', () => {
        const src: SingleRange = { row: [0, 0], column: [0, 0] };
        const ctx = makeCtx((d) => {
            d[0][0] = { f: '=5/2', v: 2.5, m: '2.5', ct: { fa: 'General', t: 'n' } };
        }, src);

        autoFillCell(ctx, src, { row: [1, 1], column: [0, 0] }, 'down');

        const filled = ctx.sheets[0].data![1][0]!;
        expect(filled.ct?.fa).toBe('General');
        expect(filled.m).toBe('2.5');
    });
});

// The fill also carries the source cell's borders. updateDropCell built those entries on a
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
            autoFillCell(ctx, { row: [0, 0], column: [0, 0] }, { row: [1, 1], column: [0, 0] }, 'down');
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
            autoFillCell(draft, src, { row: [2, 3], column: [0, 0] }, 'down');
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
            autoFillCell(draft, { row: [0, 0], column: [0, 0] }, { row: [1, 1], column: [0, 0] }, 'down');
        });

        expect(filled.sheets[0].config!.borderInfo).toEqual({});
    });
});

// Validation rules ride along with the fill in Excel and Google Sheets. updateDropCell
// carried them on a cloneDeep of the sheet's dataVerification and never wrote the clone
// back, so a dragged cell arrived with no rule — the same dead-clone shape the borders
// above had. Source and apply ranges are disjoint by construction (onDropCellSelectEnd
// starts the apply range one row/column past the copy block), so writing the live map
// while reading it cannot re-read a just-filled entry.
describe('drag-fill carries the source cell data validation', () => {
    const rule: DataVerificationRule = {
        type: 'dropdown',
        type2: '',
        value1: 'yes,no',
        value2: '',
        validity: '',
        remote: false,
        prohibitInput: false,
        hintShow: false,
        hintValue: '',
    };

    function verifiedContext(): Context {
        const src: SingleRange = { row: [0, 0], column: [0, 0] };
        const ctx = makeCtx((d) => {
            d[0][0] = { v: 'yes', m: 'yes', ct: { fa: 'General', t: 'g' } };
        }, src);
        ctx.sheets[0].dataVerification = { '0_0': rule };
        return ctx;
    }

    it('lands the rule on every filled cell', () => {
        const [filled] = produceWithPatches(verifiedContext(), (ctx: Context) => {
            autoFillCell(ctx, { row: [0, 0], column: [0, 0] }, { row: [1, 2], column: [0, 0] }, 'down');
        });

        expect(filled.sheets[0].dataVerification?.['1_0']).toEqual(rule);
        expect(filled.sheets[0].dataVerification?.['2_0']).toEqual(rule);
    });

    it('and the patch that survives filterPatch carries it, so peers and undo see it', () => {
        const base = verifiedContext();
        const [, patches] = produceWithPatches(base, (ctx: Context) => {
            autoFillCell(ctx, { row: [0, 0], column: [0, 0] }, { row: [1, 1], column: [0, 0] }, 'down');
        });

        const synced = applyPatches(base, filterPatch(patches));
        expect(synced.sheets[0].dataVerification?.['1_0']).toEqual(rule);
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
        autoFillCell(ctx, src, apply, direction);
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

    it('autoFillCell with a merged source', () => {
        const src: SingleRange = { row: [0, 0], column: [0, 1] };
        expectUnchanged(mergedContext({ r: 0, c: 0, rs: 1, cs: 2 }, src), (ctx) =>
            autoFillCell(ctx, src, { row: [1, 2], column: [0, 1] }, 'down'),
        );
    });

    // Drags the fill handle from A1 down to row 3 (y = 50 lands in the third 20px row).
    function dragDown(ctx: Context) {
        Object.assign(ctx, { rowHeaderWidth: 0, columnHeaderHeight: 0, cellSelectExtendIndex: [0, 0] });
        ctx.selections = [
            { row: [0, 0], column: [0, 0], row_focus: 0, column_focus: 0, top: 0, left: 0, height: 19, width: 73 },
        ];
        const container = {
            getBoundingClientRect: () => ({ left: 0, top: 0 }),
            querySelectorAll: () => [],
        } as unknown as HTMLDivElement;
        onDropCellSelectEnd(ctx, { pageX: 10, pageY: 50 } as MouseEvent, container);
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

        autoFillCell(ctx, src, { row: [1, 1], column: [1, 1] }, 'down');

        const filled = ctx.sheets[0].data![1][1]!;
        expect([filled.v, filled.m]).toEqual(['008', '008']);
    });

    it('recalcs when its precedent changes', () => {
        const src: SingleRange = { row: [0, 0], column: [1, 1] };
        const ctx = makeCtx((d) => {
            for (let r = 0; r < 3; r += 1) d[r][0] = { v: r + 1, m: `${r + 1}` };
            d[0][1] = { f: '=A1*2', v: 2, m: '2' };
        }, src);
        ctx.sheets[0].calcChain = [{ r: 0, c: 1, id: 'id_1' }];
        warmFormulaCellInfoMap(ctx);

        autoFillCell(ctx, src, { row: [1, 2], column: [1, 1] }, 'down');
        execFunctionGroup(ctx, 2, 0, 10, 'id_1');
        setCellValue(ctx, 2, 0, ctx.sheets[0].data, 10);
        groupValuesRefresh(ctx);

        expect(ctx.sheets[0].data![2][1]?.v).toBe(20);
    });
});
