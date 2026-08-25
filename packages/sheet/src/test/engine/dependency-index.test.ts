import { describe, expect, test } from 'bun:test';
import { DependencyIndex } from '../../engine/dependency-index';
import type { FormulaDependency } from '../../engine/types';

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
