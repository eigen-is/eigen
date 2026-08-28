// Drag-fill number-format handling (SHEETS-TODO group 1). Pins the decided
// Excel/Google-parity contract: a dragged formula cell keeps its number format
// in ALL four directions, and the display string renders through that format's
// mask instead of an auto-detected one.
//
// Entry point: autoFillCell(ctx, copyRange, applyRange, direction) — the same
// door onDropCellSelectEnd uses. It primes dropCellCache and calls
// updateDropCell; results land in ctx.sheets[0].data (getFlowdata identity).

import { describe, expect, it } from 'bun:test';
import { enablePatches, produceWithPatches } from 'immer';
import { autoFillCell } from '../../../state/api/cell';
import type { Context } from '../../../state/context';
import type { BorderInfo, Cell, SheetConfig, SingleRange } from '../../../state/types';
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
// cloneDeep of ctx.config and dropped the clone on the floor — the carried borders reached
// neither the mirror the renderer paints from nor the sheet half that syncs, so dragging a
// bordered cell produced no border at all. Driven through produceWithPatches so the two
// halves are the independent drafts they are in the app, not one aliased object.
describe('drag-fill carries the source cell borders', () => {
    const SIDE = { style: 1, color: '#000' };
    const sourceBorder: BorderInfo = {
        rangeType: 'cell',
        value: { row_index: 0, col_index: 0, l: SIDE, r: SIDE, t: SIDE, b: SIDE },
    };

    // The Workbook seeding effect assigns `draftCtx.config = sheet.config`, so the mirror and
    // the sheet's config start as the same object — reproduce that, not two clones.
    function borderedContext(): Context {
        const config: SheetConfig = { borderInfo: [sourceBorder] };
        const src: SingleRange = { row: [0, 0], column: [0, 0] };
        const ctx = makeCtx((d) => {
            d[0][0] = { v: 1, m: '1', ct: { fa: 'General', t: 'n' } };
        }, src);
        ctx.config = config;
        ctx.sheets[0].config = config;
        return ctx;
    }

    function borderedCells(config: SheetConfig | undefined) {
        return (config?.borderInfo ?? [])
            .filter((entry) => entry.rangeType === 'cell')
            .map((entry) => `${entry.value.row_index}_${entry.value.col_index}`);
    }

    it('lands the carried border on both halves of the config mirror', () => {
        const [filled] = produceWithPatches(borderedContext(), (ctx: Context) => {
            autoFillCell(ctx, { row: [0, 0], column: [0, 0] }, { row: [1, 1], column: [0, 0] }, 'down');
        });

        expect(borderedCells(filled.sheets[0].config)).toEqual(['0_0', '1_0']);
        expect(borderedCells(filled.config)).toEqual(['0_0', '1_0']);
    });
});
