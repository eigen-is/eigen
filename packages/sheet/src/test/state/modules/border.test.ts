// `config.borderInfo` is a per-cell map keyed "r_c": every toolbar layout expands into the
// cells' own sides at write time, so nothing depends on entry order any more and two clients
// bordering different cells converge (border-convergence.test.ts). This pins the geometry of
// each BorderType, the erase semantics of border-none, the merge-edge filter the compute
// applies at render time, and the patch granularity the Yjs sync depends on.

import { describe, expect, test } from 'bun:test';
import type { BorderType, CellBorderSides } from '@workspace/lib/sheets';
import type { Context } from '../../../state/context';
import { clearSides, getBorderInfoCompute } from '../../../state/modules/border';
import { handleBorder } from '../../../state/modules/toolbar';
import { syncablePaths } from '../factories/collab';
import { contextFactory } from '../factories/context';

const SIDE = { style: 1, color: '#000' };

function withSelection(row: number[], column: number[]): Context {
    const ctx = contextFactory({ config: { borderInfo: {} } }) as Context;
    ctx.selections = [{ row, column, row_focus: row[0], column_focus: column[0] }];
    return ctx;
}

// Rows 0-1, columns 0-2 — small enough to spell out every cell.
function bordered(type: BorderType): Record<string, CellBorderSides> {
    const ctx = withSelection([0, 1], [0, 2]);
    handleBorder(ctx, type);
    return ctx.sheets[0].config!.borderInfo!;
}

describe('handleBorder expands each layout into per-cell sides', () => {
    test('border-all gives every cell all four sides', () => {
        const map = bordered('border-all');
        expect(Object.keys(map)).toHaveLength(6);
        for (const sides of Object.values(map)) {
            expect(sides).toEqual({ l: SIDE, r: SIDE, t: SIDE, b: SIDE });
        }
    });

    test('border-outside only touches the rectangle edges', () => {
        expect(bordered('border-outside')).toEqual({
            '0_0': { t: SIDE, l: SIDE },
            '0_1': { t: SIDE },
            '0_2': { t: SIDE, r: SIDE },
            '1_0': { b: SIDE, l: SIDE },
            '1_1': { b: SIDE },
            '1_2': { b: SIDE, r: SIDE },
        });
    });

    test('border-inside puts each inner edge on the cell below / right of it', () => {
        expect(bordered('border-inside')).toEqual({
            '0_1': { l: SIDE },
            '0_2': { l: SIDE },
            '1_0': { t: SIDE },
            '1_1': { t: SIDE, l: SIDE },
            '1_2': { t: SIDE, l: SIDE },
        });
    });

    test('border-horizontal: first row takes the edge below it, last row the edge above', () => {
        expect(bordered('border-horizontal')).toEqual({
            '0_0': { b: SIDE },
            '0_1': { b: SIDE },
            '0_2': { b: SIDE },
            '1_0': { t: SIDE },
            '1_1': { t: SIDE },
            '1_2': { t: SIDE },
        });
    });

    test('border-horizontal on a single row still gets a bottom edge', () => {
        const ctx = withSelection([1, 1], [0, 1]);
        handleBorder(ctx, 'border-horizontal');
        expect(ctx.sheets[0].config!.borderInfo).toEqual({ '1_0': { b: SIDE }, '1_1': { b: SIDE } });
    });

    test('border-horizontal inner rows take both edges', () => {
        const ctx = withSelection([0, 2], [0, 0]);
        handleBorder(ctx, 'border-horizontal');
        expect(ctx.sheets[0].config!.borderInfo).toEqual({
            '0_0': { b: SIDE },
            '1_0': { t: SIDE, b: SIDE },
            '2_0': { t: SIDE },
        });
    });

    test('border-vertical mirrors border-horizontal by column', () => {
        expect(bordered('border-vertical')).toEqual({
            '0_0': { r: SIDE },
            '0_1': { l: SIDE, r: SIDE },
            '0_2': { l: SIDE },
            '1_0': { r: SIDE },
            '1_1': { l: SIDE, r: SIDE },
            '1_2': { l: SIDE },
        });
    });

    test('border-left / right / top / bottom stamp one edge of the rectangle', () => {
        expect(bordered('border-left')).toEqual({ '0_0': { l: SIDE }, '1_0': { l: SIDE } });
        expect(bordered('border-right')).toEqual({ '0_2': { r: SIDE }, '1_2': { r: SIDE } });
        expect(bordered('border-top')).toEqual({ '0_0': { t: SIDE }, '0_1': { t: SIDE }, '0_2': { t: SIDE } });
        expect(bordered('border-bottom')).toEqual({ '1_0': { b: SIDE }, '1_1': { b: SIDE }, '1_2': { b: SIDE } });
    });

    test('border-slash stamps the diagonal on every cell of every selected range', () => {
        const ctx = withSelection([0, 0], [0, 1]);
        ctx.selections!.push({ row: [2, 2], column: [2, 2], row_focus: 2, column_focus: 2 });
        handleBorder(ctx, 'border-slash');
        expect(ctx.sheets[0].config!.borderInfo).toEqual({
            '0_0': { s: SIDE },
            '0_1': { s: SIDE },
            '2_2': { s: SIDE },
        });
    });

    test('the toolbar style string is stored as a number and the colour passes through', () => {
        const ctx = withSelection([0, 0], [0, 0]);
        handleBorder(ctx, 'border-all', '#ff0000', '13');
        expect(ctx.sheets[0].config!.borderInfo!['0_0']!.l).toEqual({ style: 13, color: '#ff0000' });
    });

    test('a second border on the same cell overwrites per side and does not grow the map', () => {
        const ctx = withSelection([0, 0], [0, 0]);
        handleBorder(ctx, 'border-all');
        handleBorder(ctx, 'border-top', '#00ff00');
        const map = ctx.sheets[0].config!.borderInfo!;
        expect(Object.keys(map)).toHaveLength(1);
        expect(map['0_0']).toEqual({ l: SIDE, r: SIDE, b: SIDE, t: { style: 1, color: '#00ff00' } });
    });

    test('a read-only sheet takes no border', () => {
        const ctx = withSelection([0, 0], [0, 0]);
        ctx.allowEdit = false;
        handleBorder(ctx, 'border-all');
        expect(ctx.sheets[0].config!.borderInfo).toEqual({});
    });
});

describe('handleBorder bounds a header-click selection to the used extent', () => {
    function sheetWithRows(rows: number, usedThrough: number): Context {
        const ctx = contextFactory({ config: { borderInfo: {} } }) as Context;
        ctx.sheets[0].data = Array.from({ length: rows }, (_, r) =>
            Array.from({ length: 4 }, (_, c) => (r <= usedThrough && c <= 1 ? { v: 'x', m: 'x' } : null)),
        );
        ctx.visibledatarow = Array.from({ length: rows }, (_, r) => (r + 1) * 20);
        ctx.visibledatacolumn = Array.from({ length: 4 }, (_, c) => (c + 1) * 74);
        return ctx;
    }

    test('a whole column stops at the last row that holds data', () => {
        const ctx = sheetWithRows(500, 4);
        ctx.selections = [{ row: [0, 499], column: [2, 2], row_focus: 0, column_focus: 2 }];
        handleBorder(ctx, 'border-all');
        expect(Object.keys(ctx.sheets[0].config!.borderInfo!)).toEqual(['0_2', '1_2', '2_2', '3_2', '4_2']);
    });

    test('a whole row stops at the last column that holds data', () => {
        const ctx = sheetWithRows(500, 4);
        ctx.selections = [{ row: [7, 7], column: [0, 3], row_focus: 7, column_focus: 0 }];
        handleBorder(ctx, 'border-all');
        expect(Object.keys(ctx.sheets[0].config!.borderInfo!)).toEqual(['7_0', '7_1']);
    });

    test('a dragged range is applied as selected, past the used extent', () => {
        const ctx = sheetWithRows(500, 0);
        ctx.selections = [{ row: [0, 3], column: [2, 2], row_focus: 0, column_focus: 2 }];
        handleBorder(ctx, 'border-all');
        expect(Object.keys(ctx.sheets[0].config!.borderInfo!)).toEqual(['0_2', '1_2', '2_2', '3_2']);
    });

    test('a bordered blank cell counts as used, so a header-click border-none can reach it', () => {
        // Data in rows 0-2, borders dragged down to row 20: the column-header click must
        // clip to the bordered extent, not the data extent, or those borders are stuck.
        const ctx = sheetWithRows(500, 2);
        ctx.selections = [{ row: [0, 20], column: [0, 1], row_focus: 0, column_focus: 0 }];
        handleBorder(ctx, 'border-all');
        expect(Object.keys(ctx.sheets[0].config!.borderInfo!)).toHaveLength(42);
        ctx.selections = [{ row: [0, 499], column: [0, 1], row_focus: 0, column_focus: 0 }];
        handleBorder(ctx, 'border-none');
        expect(ctx.sheets[0].config!.borderInfo).toEqual({});
    });
});

describe('border-none erases', () => {
    test('the range entries and the facing sides of the outside neighbours', () => {
        const ctx = withSelection([0, 2], [0, 2]);
        handleBorder(ctx, 'border-all');
        ctx.selections = [{ row: [1, 1], column: [1, 1] }];
        handleBorder(ctx, 'border-none');

        const map = ctx.sheets[0].config!.borderInfo!;
        expect(map['1_1']).toBeUndefined();
        expect(map['0_1']).toEqual({ l: SIDE, r: SIDE, t: SIDE });
        expect(map['2_1']).toEqual({ l: SIDE, r: SIDE, b: SIDE });
        expect(map['1_0']).toEqual({ l: SIDE, t: SIDE, b: SIDE });
        expect(map['1_2']).toEqual({ r: SIDE, t: SIDE, b: SIDE });
        // Diagonal neighbours share no edge with the erased cell.
        expect(map['0_0']).toEqual({ l: SIDE, r: SIDE, t: SIDE, b: SIDE });
    });

    test('a neighbour left with no sides is deleted, not kept as {}', () => {
        const ctx = withSelection([0, 0], [0, 0]);
        handleBorder(ctx, 'border-bottom');
        ctx.selections = [{ row: [1, 1], column: [0, 0] }];
        handleBorder(ctx, 'border-none');
        expect(ctx.sheets[0].config!.borderInfo).toEqual({});
    });
});

describe('getBorderInfoCompute', () => {
    test('shows a merged cell only the sides on the merge outer edge; storage keeps them all', () => {
        const ctx = withSelection([0, 3], [0, 3]);
        const mc = { r: 1, c: 1, rs: 2, cs: 2 };
        ctx.sheets[0].config!.merge = { '1_1': mc };
        const data = ctx.sheets[0].data!;
        data[1][1] = { mc };
        data[1][2] = { mc: { r: 1, c: 1 } };
        data[2][1] = { mc: { r: 1, c: 1 } };
        data[2][2] = { mc: { r: 1, c: 1 } };
        handleBorder(ctx, 'border-all');

        const computed = getBorderInfoCompute(ctx, ctx.currentSheetId, [0, 3, 0, 3]);
        expect(computed['1_1']).toEqual({ l: SIDE, t: SIDE });
        expect(computed['1_2']).toEqual({ r: SIDE, t: SIDE });
        expect(computed['2_1']).toEqual({ l: SIDE, b: SIDE });
        expect(computed['2_2']).toEqual({ r: SIDE, b: SIDE });
        expect(computed['0_0']).toEqual({ l: SIDE, r: SIDE, t: SIDE, b: SIDE });
        expect(ctx.sheets[0].config!.borderInfo!['2_2']).toEqual({ l: SIDE, r: SIDE, t: SIDE, b: SIDE });
    });

    test('keeps hidden rows and columns: every carry reads stored sides, the painter skips them', () => {
        const ctx = withSelection([0, 1], [0, 1]);
        ctx.sheets[0].config!.rowhidden = { 1: 0 };
        ctx.sheets[0].config!.colhidden = { 1: 0 };
        handleBorder(ctx, 'border-all');
        const computed = getBorderInfoCompute(ctx, ctx.currentSheetId, [0, 1, 0, 1]);
        expect(Object.keys(computed)).toEqual(['0_0', '0_1', '1_0', '1_1']);
    });

    test('walks only the range', () => {
        const ctx = withSelection([0, 3], [0, 3]);
        handleBorder(ctx, 'border-all');
        expect(Object.keys(getBorderInfoCompute(ctx, ctx.currentSheetId, [1, 2, 2, 2]))).toEqual(['1_2', '2_2']);
    });

    test('an empty map yields nothing for any range', () => {
        expect(getBorderInfoCompute(withSelection([0, 0], [0, 0]), 'sheet-1', [0, 1000000, 0, 40])).toEqual({});
    });

    test('a range larger than the map reads the same as one smaller than it', () => {
        const ctx = withSelection([1, 2], [1, 2]);
        handleBorder(ctx, 'border-outside');
        const byMap = getBorderInfoCompute(ctx, ctx.currentSheetId, [0, 1000000, 0, 40]);
        const byRange = getBorderInfoCompute(ctx, ctx.currentSheetId, [1, 2, 1, 2]);
        expect(byMap).toEqual(byRange);
        expect(Object.keys(byMap)).toHaveLength(4);
    });
});

describe('clearSides', () => {
    test('a rectangle larger than the map clears by walking the map', () => {
        const map: Record<string, CellBorderSides> = {
            '5_5': { l: SIDE },
            '999999_0': { l: SIDE },
            '2_50': { l: SIDE },
        };
        clearSides(map, 0, 1000000, 0, 40);
        expect(map).toEqual({ '2_50': { l: SIDE } });
    });

    test('a one-cell rectangle into a larger map clears by walking the rectangle', () => {
        const map: Record<string, CellBorderSides> = { '0_0': { l: SIDE }, '0_1': { l: SIDE }, '1_1': { l: SIDE } };
        clearSides(map, 1, 1, 1, 1);
        expect(map).toEqual({ '0_0': { l: SIDE }, '0_1': { l: SIDE } });
    });
});

describe('border patches stay granular', () => {
    test('a border on a fresh cell adds just that key', () => {
        const paths = syncablePaths(withSelection([0, 0], [0, 0]), (ctx) => handleBorder(ctx, 'border-all'));
        expect(paths).toEqual([['sheets', 0, 'config', 'borderInfo', '0_0']]);
    });

    test('a second border on an existing cell replaces only the side', () => {
        const base = withSelection([0, 0], [0, 0]);
        handleBorder(base, 'border-all');
        const paths = syncablePaths(base, (ctx) => handleBorder(ctx, 'border-top', '#00ff00'));
        expect(paths).toEqual([['sheets', 0, 'config', 'borderInfo', '0_0', 't']]);
    });

    test('border-none on a neighbour removes only its facing side', () => {
        const base = withSelection([0, 0], [0, 0]);
        handleBorder(base, 'border-all');
        base.selections = [{ row: [1, 1], column: [0, 0] }];
        const paths = syncablePaths(base, (ctx) => handleBorder(ctx, 'border-none'));
        expect(paths).toEqual([['sheets', 0, 'config', 'borderInfo', '0_0', 'b']]);
    });
});
