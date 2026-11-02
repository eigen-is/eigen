import { describe, expect, test } from 'bun:test';
import { DependencyIndex, dependencySlots } from '../../engine/dependency-index';
import type { FormulaDependency } from '../../engine/types';

// No sheet extent: every range is listed in the blocks it meets.
const unknownExtent = () => undefined;

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
        index.set('f1', [dep(2, 2, 3, 3)], unknownExtent);
        expect(index.dependentsOf('s1', 2, 3)).toEqual(['f1']);
        expect(index.dependentsOf('s1', 2, 4)).toEqual([]);
        expect(index.dependentsOf('s1', 3, 3)).toEqual([]);
    });

    test('range dependency resolves for cells inside, not outside', () => {
        const index = new DependencyIndex();
        index.set('f1', [dep(1, 5, 0, 2)], unknownExtent);
        expect(index.dependentsOf('s1', 1, 0)).toEqual(['f1']);
        expect(index.dependentsOf('s1', 5, 2)).toEqual(['f1']);
        expect(index.dependentsOf('s1', 3, 1)).toEqual(['f1']);
        expect(index.dependentsOf('s1', 0, 0)).toEqual([]);
        expect(index.dependentsOf('s1', 6, 0)).toEqual([]);
        expect(index.dependentsOf('s1', 3, 3)).toEqual([]);
    });

    test('dependencies are scoped to their sheet', () => {
        const index = new DependencyIndex();
        index.set('f1', [dep(0, 0, 0, 0, 'other')], unknownExtent);
        expect(index.dependentsOf('s1', 0, 0)).toEqual([]);
        expect(index.dependentsOf('other', 0, 0)).toEqual(['f1']);
    });

    test('multiple formulas depending on the same cell are all returned', () => {
        const index = new DependencyIndex();
        index.set('f1', [dep(0, 0, 0, 0)], unknownExtent);
        index.set('f2', [dep(0, 10, 0, 0)], unknownExtent);
        index.set('f3', [dep(5, 5, 5, 5)], unknownExtent);
        expect([...index.dependentsOf('s1', 0, 0)].sort()).toEqual(['f1', 'f2']);
    });

    test('a formula with overlapping ranges is returned once', () => {
        const index = new DependencyIndex();
        index.set('f1', [dep(0, 0, 0, 0), dep(0, 5, 0, 5)], unknownExtent);
        expect(index.dependentsOf('s1', 0, 0)).toEqual(['f1']);
    });

    test('a cell referenced twice by one formula is listed once', () => {
        const index = new DependencyIndex();
        // `=A1+A1` extracts the same point dependency twice.
        index.set('f1', [dep(0, 0, 0, 0), dep(0, 0, 0, 0)], unknownExtent);
        expect(index.dependentsOf('s1', 0, 0)).toEqual(['f1']);
    });

    test('set replaces earlier dependencies for the same key', () => {
        const index = new DependencyIndex();
        index.set('f1', [dep(0, 0, 0, 0)], unknownExtent);
        index.set('f1', [dep(9, 9, 9, 9)], unknownExtent);
        expect(index.dependentsOf('s1', 0, 0)).toEqual([]);
        expect(index.dependentsOf('s1', 9, 9)).toEqual(['f1']);
    });

    test('delete removes all dependencies of the key', () => {
        const index = new DependencyIndex();
        index.set('f1', [dep(0, 0, 0, 0), dep(0, 100, 3, 3)], unknownExtent);
        index.delete('f1');
        expect(index.dependentsOf('s1', 0, 0)).toEqual([]);
        expect(index.dependentsOf('s1', 50, 3)).toEqual([]);
    });

    test('clear empties the whole index', () => {
        const index = new DependencyIndex();
        index.set('f1', [dep(0, 0, 0, 0)], unknownExtent);
        index.set('f2', [dep(0, 500, 0, 50, 's2')], unknownExtent);
        index.clear();
        expect(index.dependentsOf('s1', 0, 0)).toEqual([]);
        expect(index.dependentsOf('s2', 250, 25)).toEqual([]);
    });

    test('tall whole-column style range spans many row blocks', () => {
        const index = new DependencyIndex();
        index.set('f1', [dep(0, 5000, 1, 1)], unknownExtent);
        expect(index.dependentsOf('s1', 0, 1)).toEqual(['f1']);
        expect(index.dependentsOf('s1', 3000, 1)).toEqual(['f1']);
        expect(index.dependentsOf('s1', 5000, 1)).toEqual(['f1']);
        expect(index.dependentsOf('s1', 5001, 1)).toEqual([]);
    });

    test('wide whole-row style range spans many column blocks', () => {
        const index = new DependencyIndex();
        index.set('f1', [dep(3, 3, 0, 1000)], unknownExtent);
        expect(index.dependentsOf('s1', 3, 0)).toEqual(['f1']);
        expect(index.dependentsOf('s1', 3, 999)).toEqual(['f1']);
        expect(index.dependentsOf('s1', 2, 500)).toEqual([]);
    });

    test('cells on block boundaries resolve correctly', () => {
        const index = new DependencyIndex();
        // Ranges straddling typical block sizes (64 rows / 16 cols)
        index.set('f1', [dep(63, 64, 15, 16)], unknownExtent);
        expect(index.dependentsOf('s1', 63, 15)).toEqual(['f1']);
        expect(index.dependentsOf('s1', 63, 16)).toEqual(['f1']);
        expect(index.dependentsOf('s1', 64, 15)).toEqual(['f1']);
        expect(index.dependentsOf('s1', 64, 16)).toEqual(['f1']);
        expect(index.dependentsOf('s1', 62, 15)).toEqual([]);
        expect(index.dependentsOf('s1', 65, 16)).toEqual([]);
    });

    test('queries reflect mutations made after a cached query', () => {
        const index = new DependencyIndex();
        index.set('f1', [dep(0, 0, 0, 0)], unknownExtent);
        expect(index.dependentsOf('s1', 0, 0)).toEqual(['f1']);
        index.set('f2', [dep(0, 3, 0, 0)], unknownExtent);
        expect([...index.dependentsOf('s1', 0, 0)].sort()).toEqual(['f1', 'f2']);
        index.delete('f1');
        expect(index.dependentsOf('s1', 0, 0)).toEqual(['f2']);
    });

    test('dependencies without a sheetId are ignored', () => {
        const index = new DependencyIndex();
        index.set('f1', [{ row: [0, 0], column: [0, 0], sheetId: undefined }], unknownExtent);
        expect(index.dependentsOf('s1', 0, 0)).toEqual([]);
    });

    test('negative or inverted bounds are clamped instead of throwing', () => {
        const index = new DependencyIndex();
        index.set('f1', [dep(-1, 2, -1, 1)], unknownExtent);
        expect(index.dependentsOf('s1', 0, 0)).toEqual(['f1']);
        expect(index.dependentsOf('s1', 2, 1)).toEqual(['f1']);
        expect(index.dependentsOf('s1', 3, 0)).toEqual([]);
    });
});

describe('engine/dependency-index — dependencySlots', () => {
    test('a range costs every 64 × 16 block it meets, a single cell none', () => {
        expect(dependencySlots([dep(5, 5, 5, 5)], unknownExtent)).toBe(0);
        expect(dependencySlots([dep(0, 63, 0, 15)], unknownExtent)).toBe(1);
        expect(dependencySlots([dep(63, 64, 15, 16)], unknownExtent)).toBe(4);
        expect(dependencySlots([dep(0, 127, 0, 31), dep(200, 200, 40, 56)], unknownExtent)).toBe(4 + 2);
        expect(dependencySlots([{ row: [0, 1], column: [0, 0], sheetId: undefined }], unknownExtent)).toBe(0);
    });

    test('the whole grid is 16 million blocks', () => {
        expect(dependencySlots([dep(0, 1_048_575, 0, 16_383)], unknownExtent)).toBe(16_384 * 1_024);
    });
});

// A sheet 64,000 rows deep and 40 columns wide.
const tallSheet = (sheetId: string) => (sheetId === 's1' ? { rows: 64_000, columns: 40 } : undefined);

describe('engine/dependency-index — a range across a whole sheet', () => {
    test('a range down every row costs one per column, one across every column one per row', () => {
        expect(dependencySlots([dep(0, 63_999, 1, 1)], tallSheet)).toBe(1);
        expect(dependencySlots([dep(0, 63_999, 0, 3)], tallSheet)).toBe(4);
        expect(dependencySlots([dep(5, 5, 0, 39)], tallSheet)).toBe(1);
        // A range past the sheet's last row runs down every row too.
        expect(dependencySlots([dep(0, 1_048_575, 2, 2)], tallSheet)).toBe(1);
        // Short of a whole column, or on a sheet whose size is unknown, a range costs its blocks.
        expect(dependencySlots([dep(1, 63_999, 1, 1)], tallSheet)).toBe(1_000);
        expect(dependencySlots([dep(0, 63_999, 1, 1, 'other')], tallSheet)).toBe(1_000);
        // The whole sheet costs its 40 columns, fewer than its 64,000 rows or its 3,000 blocks.
        expect(dependencySlots([dep(0, 63_999, 0, 39)], tallSheet)).toBe(40);
    });

    test('a whole column is found for each of its cells and for no other', () => {
        const index = new DependencyIndex();
        index.set('f1', [dep(0, 63_999, 1, 2)], tallSheet);
        expect(index.dependentsOf('s1', 0, 1)).toEqual(['f1']);
        expect(index.dependentsOf('s1', 40_000, 2)).toEqual(['f1']);
        expect(index.dependentsOf('s1', 63_999, 1)).toEqual(['f1']);
        expect(index.dependentsOf('s1', 64_000, 1)).toEqual([]);
        expect(index.dependentsOf('s1', 40_000, 3)).toEqual([]);
        expect(index.dependentsOf('s1', 40_000, 0)).toEqual([]);
    });

    test('a whole row is found for each of its cells and for no other', () => {
        const index = new DependencyIndex();
        index.set('f1', [dep(7, 8, 0, 39)], tallSheet);
        expect(index.dependentsOf('s1', 7, 0)).toEqual(['f1']);
        expect(index.dependentsOf('s1', 8, 39)).toEqual(['f1']);
        expect(index.dependentsOf('s1', 8, 40)).toEqual([]);
        expect(index.dependentsOf('s1', 9, 0)).toEqual([]);
    });

    test('whole columns, whole rows, blocks and cells are found together, and delete drops them', () => {
        const index = new DependencyIndex();
        index.set('column', [dep(0, 63_999, 1, 1)], tallSheet);
        index.set('row', [dep(3, 3, 0, 39)], tallSheet);
        index.set('block', [dep(0, 9, 0, 9)], tallSheet);
        index.set('cell', [dep(3, 3, 1, 1)], tallSheet);
        expect([...index.dependentsOf('s1', 3, 1)].sort()).toEqual(['block', 'cell', 'column', 'row']);
        index.delete('column');
        index.delete('row');
        expect([...index.dependentsOf('s1', 3, 1)].sort()).toEqual(['block', 'cell']);
        expect(index.dependentsOf('s1', 500, 1)).toEqual([]);
    });
});
