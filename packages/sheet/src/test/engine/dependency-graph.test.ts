import { describe, expect, test } from 'bun:test';
import { getCalculationOrder } from '../../engine/dependency-graph';
import type { FormulaCellInfo } from '../../engine/types';

// A formula per key, and for each the formulas that read it.
function graph(edges: Record<string, string[]>) {
    const nodes: Record<string, FormulaCellInfo> = {};
    for (const key of Object.keys(edges)) nodes[key] = { key, r: 0, c: 0, id: 'sheet1', formula: '=A1' };
    const readers = new Map(Object.entries(edges).map(([key, keys]) => [nodes[key], keys.map((k) => nodes[k])]));
    return { nodes, readers };
}

// ─── getCalculationOrder ─────────────────────────────────────────────────────

describe('engine/dependency-graph — getCalculationOrder', () => {
    test('empty input returns empty list', () => {
        expect(getCalculationOrder([], new Map())).toEqual([]);
    });

    test('single formula with no dependencies returns it as-is', () => {
        const { nodes, readers } = graph({ a: [] });
        const result = getCalculationOrder([nodes.a], readers);
        expect(result.map((cell) => cell.key)).toEqual(['a']);
    });

    test('base cell comes before its dependent in the result', () => {
        const { nodes, readers } = graph({ a: ['b'], b: [] });
        const keys = getCalculationOrder([nodes.a], readers).map((cell) => cell.key);
        expect(keys).toHaveLength(2);
        expect(keys.indexOf('a')).toBeLessThan(keys.indexOf('b'));
    });

    test('chain A←B←C: C evaluates first, then B, then A', () => {
        const { nodes, readers } = graph({ c: ['b'], b: ['a'], a: [] });
        const keys = getCalculationOrder([nodes.c], readers).map((cell) => cell.key);
        expect(keys).toEqual(['c', 'b', 'a']);
    });

    test('duplicate cells in input are only included once', () => {
        const { nodes, readers } = graph({ a: [] });
        expect(getCalculationOrder([nodes.a, nodes.a], readers)).toHaveLength(1);
    });

    test('hub cell precedes all of its dependents', () => {
        const n = 5000;
        const keys = Array.from({ length: n }, (_, i) => `dep${i}`);
        const { nodes, readers } = graph({ hub: keys, ...Object.fromEntries(keys.map((key) => [key, []])) });
        const result = getCalculationOrder([nodes.hub], readers);
        expect(result).toHaveLength(n + 1);
        expect(result[0].key).toBe('hub');
    });

    test('cyclic graph terminates and yields every node exactly once', () => {
        // Spreadsheets do contain circular references; recalc.ts relies on the sort
        // being cycle-tolerant by construction (no throw, no hang).
        const { nodes, readers } = graph({ a: ['b'], b: ['c'], c: ['a'] });
        const result = getCalculationOrder([nodes.a], readers);
        expect(result.map((cell) => cell.key).sort()).toEqual(['a', 'b', 'c']);
    });

    test('long dependency chain keeps strict base-to-dependent order', () => {
        // c0 ← c1 ← … ← cN (each cell's value feeds the next). Import-scale depth:
        // the pre-fix concat-based stack made this quadratic (17s of a 21s import).
        const n = 30000;
        const edges: Record<string, string[]> = {};
        for (let i = 0; i < n; i++) edges[`c${i}`] = i < n - 1 ? [`c${i + 1}`] : [];
        const { nodes, readers } = graph(edges);
        const result = getCalculationOrder([nodes.c0], readers);
        expect(result).toHaveLength(n);
        const position = new Map(result.map((cell, index) => [cell.key, index]));
        for (let i = 0; i < n - 1; i++) {
            expect(position.get(`c${i}`)).toBeLessThan(position.get(`c${i + 1}`) ?? -1);
        }
    });
});
