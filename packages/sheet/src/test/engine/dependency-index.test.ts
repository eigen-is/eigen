import { describe, expect, test } from 'bun:test';
import { DependencyIndex, dependencySlots } from '../../engine/dependency-index';
import type { FormulaDependency } from '../../engine/types';

// A whole column and a whole row, as the walk resolves them.
const LAST_ROW = 1_048_575;
const LAST_COLUMN = 16_383;

function dep(r0: number, r1: number, c0: number, c1: number, sheetId = 's1'): FormulaDependency {
    return { row: [r0, r1], column: [c0, c1], sheetId };
}

describe('engine/dependency-index — DependencyIndex', () => {
    test('empty index has no dependents', () => {
        const index = new DependencyIndex();
        expect(index.dependentsOf('s1', 0, 0)).toEqual([]);
    });

    test('single-cell dependency resolves for that cell only', () => {
        const index = new DependencyIndex();
        index.set('f1', [dep(2, 2, 3, 3)]);
        expect(index.dependentsOf('s1', 2, 3)).toEqual(['f1']);
        expect(index.dependentsOf('s1', 2, 4)).toEqual([]);
        expect(index.dependentsOf('s1', 3, 3)).toEqual([]);
    });

    test('range dependency resolves for cells inside, not outside', () => {
        const index = new DependencyIndex();
        index.set('f1', [dep(1, 5, 0, 2)]);
        expect(index.dependentsOf('s1', 1, 0)).toEqual(['f1']);
        expect(index.dependentsOf('s1', 5, 2)).toEqual(['f1']);
        expect(index.dependentsOf('s1', 3, 1)).toEqual(['f1']);
        expect(index.dependentsOf('s1', 0, 0)).toEqual([]);
        expect(index.dependentsOf('s1', 6, 0)).toEqual([]);
        expect(index.dependentsOf('s1', 3, 3)).toEqual([]);
    });

    test('dependencies are scoped to their sheet', () => {
        const index = new DependencyIndex();
        index.set('f1', [dep(0, 0, 0, 0, 'other')]);
        expect(index.dependentsOf('s1', 0, 0)).toEqual([]);
        expect(index.dependentsOf('other', 0, 0)).toEqual(['f1']);
    });

    test('multiple formulas depending on the same cell are all returned', () => {
        const index = new DependencyIndex();
        index.set('f1', [dep(0, 0, 0, 0)]);
        index.set('f2', [dep(0, 10, 0, 0)]);
        index.set('f3', [dep(5, 5, 5, 5)]);
        expect([...index.dependentsOf('s1', 0, 0)].sort()).toEqual(['f1', 'f2']);
    });

    test('a formula with overlapping ranges is returned once', () => {
        const index = new DependencyIndex();
        index.set('f1', [dep(0, 0, 0, 0), dep(0, 5, 0, 5)]);
        expect(index.dependentsOf('s1', 0, 0)).toEqual(['f1']);
    });

    test('a cell referenced twice by one formula is listed once', () => {
        const index = new DependencyIndex();
        // `=A1+A1` extracts the same point dependency twice.
        index.set('f1', [dep(0, 0, 0, 0), dep(0, 0, 0, 0)]);
        expect(index.dependentsOf('s1', 0, 0)).toEqual(['f1']);
    });

    test('a formula that reads a cell twice leaves the formulas beside it when it goes', () => {
        const index = new DependencyIndex();
        index.set('twice', [dep(0, 0, 0, 0), dep(0, 0, 0, 0)]);
        index.set('other', [dep(0, 0, 0, 0)]);
        index.delete('twice');
        expect(index.dependentsOf('s1', 0, 0)).toEqual(['other']);
    });

    test('formulas that read one cell cost about one write each', () => {
        const index = new DependencyIndex();
        const shared = [dep(0, 0, 0, 0)];
        const start = performance.now();
        for (let i = 0; i < 120_000; i += 1) index.set(`f${i}`, shared);
        // A scan of the cell's list per formula takes about 18 s, and this takes about 30 ms.
        expect(performance.now() - start).toBeLessThan(3_000);
        expect(index.dependentsOf('s1', 0, 0)).toHaveLength(120_000);
    }, 60_000);

    test('set replaces earlier dependencies for the same key', () => {
        const index = new DependencyIndex();
        index.set('f1', [dep(0, 0, 0, 0)]);
        index.set('f1', [dep(9, 9, 9, 9)]);
        expect(index.dependentsOf('s1', 0, 0)).toEqual([]);
        expect(index.dependentsOf('s1', 9, 9)).toEqual(['f1']);
    });

    test('delete removes all dependencies of the key', () => {
        const index = new DependencyIndex();
        index.set('f1', [dep(0, 0, 0, 0), dep(0, 100, 3, 3)]);
        index.delete('f1');
        expect(index.dependentsOf('s1', 0, 0)).toEqual([]);
        expect(index.dependentsOf('s1', 50, 3)).toEqual([]);
    });

    test('clear empties the whole index', () => {
        const index = new DependencyIndex();
        index.set('f1', [dep(0, 0, 0, 0)]);
        index.set('f2', [dep(0, 500, 0, 50, 's2')]);
        index.clear();
        expect(index.dependentsOf('s1', 0, 0)).toEqual([]);
        expect(index.dependentsOf('s2', 250, 25)).toEqual([]);
    });

    test('tall whole-column style range spans many row blocks', () => {
        const index = new DependencyIndex();
        index.set('f1', [dep(0, 5000, 1, 1)]);
        expect(index.dependentsOf('s1', 0, 1)).toEqual(['f1']);
        expect(index.dependentsOf('s1', 3000, 1)).toEqual(['f1']);
        expect(index.dependentsOf('s1', 5000, 1)).toEqual(['f1']);
        expect(index.dependentsOf('s1', 5001, 1)).toEqual([]);
    });

    test('wide whole-row style range spans many column blocks', () => {
        const index = new DependencyIndex();
        index.set('f1', [dep(3, 3, 0, 1000)]);
        expect(index.dependentsOf('s1', 3, 0)).toEqual(['f1']);
        expect(index.dependentsOf('s1', 3, 999)).toEqual(['f1']);
        expect(index.dependentsOf('s1', 2, 500)).toEqual([]);
    });

    test('cells on block boundaries resolve correctly', () => {
        const index = new DependencyIndex();
        // Ranges straddling typical block sizes (64 rows / 16 cols)
        index.set('f1', [dep(63, 64, 15, 16)]);
        expect(index.dependentsOf('s1', 63, 15)).toEqual(['f1']);
        expect(index.dependentsOf('s1', 63, 16)).toEqual(['f1']);
        expect(index.dependentsOf('s1', 64, 15)).toEqual(['f1']);
        expect(index.dependentsOf('s1', 64, 16)).toEqual(['f1']);
        expect(index.dependentsOf('s1', 62, 15)).toEqual([]);
        expect(index.dependentsOf('s1', 65, 16)).toEqual([]);
    });

    test('queries reflect mutations made after a cached query', () => {
        const index = new DependencyIndex();
        index.set('f1', [dep(0, 0, 0, 0)]);
        expect(index.dependentsOf('s1', 0, 0)).toEqual(['f1']);
        index.set('f2', [dep(0, 3, 0, 0)]);
        expect([...index.dependentsOf('s1', 0, 0)].sort()).toEqual(['f1', 'f2']);
        index.delete('f1');
        expect(index.dependentsOf('s1', 0, 0)).toEqual(['f2']);
    });

    test('dependencies without a sheetId are ignored', () => {
        const index = new DependencyIndex();
        index.set('f1', [{ row: [0, 0], column: [0, 0], sheetId: undefined }]);
        expect(index.dependentsOf('s1', 0, 0)).toEqual([]);
    });

    test('negative or inverted bounds are clamped instead of throwing', () => {
        const index = new DependencyIndex();
        index.set('f1', [dep(-1, 2, -1, 1)]);
        expect(index.dependentsOf('s1', 0, 0)).toEqual(['f1']);
        expect(index.dependentsOf('s1', 2, 1)).toEqual(['f1']);
        expect(index.dependentsOf('s1', 3, 0)).toEqual([]);
    });
});

describe('engine/dependency-index — dependencySlots', () => {
    test('a range costs every 64 × 16 block it meets, a single cell none', () => {
        expect(dependencySlots([dep(5, 5, 5, 5)])).toBe(0);
        expect(dependencySlots([dep(0, 63, 0, 15)])).toBe(1);
        expect(dependencySlots([dep(63, 64, 15, 16)])).toBe(4);
        expect(dependencySlots([dep(0, 127, 0, 31), dep(200, 200, 40, 56)])).toBe(4 + 2);
        expect(dependencySlots([{ row: [0, 1], column: [0, 0], sheetId: undefined }])).toBe(0);
    });

    test('the whole grid costs a slot per column, and a range short of it its 16 million blocks', () => {
        expect(dependencySlots([dep(0, LAST_ROW, 0, LAST_COLUMN)])).toBe(16_384);
        expect(dependencySlots([dep(1, LAST_ROW - 1, 1, LAST_COLUMN - 1)])).toBe(16_384 * 1_024);
    });
});

describe('engine/dependency-index — a whole column or row', () => {
    test('a whole column costs one per column, a whole row one per row', () => {
        expect(dependencySlots([dep(0, LAST_ROW, 1, 1)])).toBe(1);
        expect(dependencySlots([dep(0, LAST_ROW, 0, 3)])).toBe(4);
        expect(dependencySlots([dep(5, 5, 0, LAST_COLUMN)])).toBe(1);
        // From below the top, as in `A5:A1048576`, it can't go by blocks either.
        expect(dependencySlots([dep(4, LAST_ROW, 2, 2)])).toBe(1);
        // A reference past Excel's grid, as in `A:ZZZZZZ`, stops at its edge.
        expect(dependencySlots([dep(0, LAST_ROW, 0, 321_272_405)])).toBe(16_384);
    });

    test('a long range from the top of its sheet costs one per column, one from below it its blocks', () => {
        expect(dependencySlots([dep(0, 63_999, 1, 1)])).toBe(1);
        expect(dependencySlots([dep(0, 63_999, 0, 39)])).toBe(40);
        expect(dependencySlots([dep(1, 63_999, 1, 1)])).toBe(1_000);
        // A short range stays with its blocks, so a lookup below it never scans it.
        expect(dependencySlots([dep(0, 1_023, 1, 1)])).toBe(16);
    });

    test('a whole column is found for each of its cells, however deep the sheet grows, and for no other', () => {
        const index = new DependencyIndex();
        index.set('f1', [dep(0, LAST_ROW, 1, 2)]);
        expect(index.dependentsOf('s1', 0, 1)).toEqual(['f1']);
        expect(index.dependentsOf('s1', 40_000, 2)).toEqual(['f1']);
        expect(index.dependentsOf('s1', LAST_ROW, 1)).toEqual(['f1']);
        expect(index.dependentsOf('s1', 40_000, 3)).toEqual([]);
        expect(index.dependentsOf('s1', 40_000, 0)).toEqual([]);
    });

    test('a long range is found only for the cells it covers', () => {
        const index = new DependencyIndex();
        index.set('f1', [dep(0, 63_999, 1, 1)]);
        expect(index.dependentsOf('s1', 63_999, 1)).toEqual(['f1']);
        expect(index.dependentsOf('s1', 64_000, 1)).toEqual([]);
    });

    test('a whole row is found for each of its cells and for no other', () => {
        const index = new DependencyIndex();
        index.set('f1', [dep(7, 8, 0, LAST_COLUMN)]);
        expect(index.dependentsOf('s1', 7, 0)).toEqual(['f1']);
        expect(index.dependentsOf('s1', 8, 39)).toEqual(['f1']);
        expect(index.dependentsOf('s1', 9, 0)).toEqual([]);
    });

    test('whole columns, whole rows, blocks and cells are found together, and delete drops them', () => {
        const index = new DependencyIndex();
        index.set('column', [dep(0, LAST_ROW, 1, 1)]);
        index.set('row', [dep(3, 3, 0, LAST_COLUMN)]);
        index.set('block', [dep(0, 9, 0, 9)]);
        index.set('cell', [dep(3, 3, 1, 1)]);
        expect([...index.dependentsOf('s1', 3, 1)].sort()).toEqual(['block', 'cell', 'column', 'row']);
        index.delete('column');
        index.delete('row');
        expect([...index.dependentsOf('s1', 3, 1)].sort()).toEqual(['block', 'cell']);
        expect(index.dependentsOf('s1', 500, 1)).toEqual([]);
    });
});
