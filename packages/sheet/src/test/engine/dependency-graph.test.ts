import { describe, expect, test } from 'bun:test';
import { getCalculationOrder } from '../../engine/dependency-graph';
import type { FormulaCellInfo, FormulaCellInfoMap } from '../../engine/types';

// Helper to build a minimal FormulaCellInfo for test use
function makeCell(key: string, dependents: string[] = []): FormulaCellInfo {
    return { key, r: 0, c: 0, id: 'sheet1', formula: '=A1', dependents };
}

// ─── getCalculationOrder ─────────────────────────────────────────────────────

describe('engine/dependency-graph — getCalculationOrder', () => {
    test('empty input returns empty list', () => {
        expect(getCalculationOrder([], {})).toEqual([]);
    });

    test('single formula with no dependencies returns it as-is', () => {
        const cell = makeCell('r0c0isheet1');
        const map: FormulaCellInfoMap = { r0c0isheet1: cell };
        const result = getCalculationOrder([cell], map);
        expect(result).toHaveLength(1);
        expect(result[0].key).toBe('r0c0isheet1');
    });

    test('base cell comes before its dependent in the result', () => {
        const a = makeCell('r0c0isheet1', ['r1c0isheet1']);
        const b = makeCell('r1c0isheet1');
        const map: FormulaCellInfoMap = {
            r0c0isheet1: a,
            r1c0isheet1: b,
        };

        const result = getCalculationOrder([a], map);
        expect(result).toHaveLength(2);
        const aIndex = result.findIndex((c) => c.key === 'r0c0isheet1');
        const bIndex = result.findIndex((c) => c.key === 'r1c0isheet1');
        // A (the base cell) must come before B (the dependent)
        expect(aIndex).toBeLessThan(bIndex);
    });

    test('chain A←B←C: C evaluates first, then B, then A', () => {
        const c = makeCell('r2c0isheet1', ['r1c0isheet1']);
        const b = makeCell('r1c0isheet1', ['r0c0isheet1']);
        const a = makeCell('r0c0isheet1');
        const map: FormulaCellInfoMap = {
            r0c0isheet1: a,
            r1c0isheet1: b,
            r2c0isheet1: c,
        };

        const result = getCalculationOrder([c], map);
        expect(result).toHaveLength(3);
        const keys = result.map((cell) => cell.key);
        expect(keys.indexOf('r2c0isheet1')).toBeLessThan(keys.indexOf('r1c0isheet1'));
        expect(keys.indexOf('r1c0isheet1')).toBeLessThan(keys.indexOf('r0c0isheet1'));
    });

    test('duplicate cells in input are only included once', () => {
        const cell = makeCell('r0c0isheet1');
        const map: FormulaCellInfoMap = { r0c0isheet1: cell };
        const result = getCalculationOrder([cell, cell], map);
        expect(result).toHaveLength(1);
    });

    test('hub cell precedes all of its dependents', () => {
        const n = 5000;
        const keys = Array.from({ length: n }, (_, i) => `dep${i}`);
        const hub = makeCell('hub', keys);
        const map: FormulaCellInfoMap = { hub };
        for (const key of keys) map[key] = makeCell(key);
        const result = getCalculationOrder([hub], map);
        expect(result).toHaveLength(n + 1);
        expect(result[0].key).toBe('hub');
    });

    test('cyclic graph terminates and yields every node exactly once', () => {
        // Spreadsheets do contain circular references; recalc.ts relies on the sort
        // being cycle-tolerant by construction (no throw, no hang).
        const a = makeCell('a', ['b']);
        const b = makeCell('b', ['c']);
        const c = makeCell('c', ['a']);
        const map: FormulaCellInfoMap = { a, b, c };
        const result = getCalculationOrder([a], map);
        expect(result.map((cell) => cell.key).sort()).toEqual(['a', 'b', 'c']);
    });

    test('long dependency chain keeps strict base-to-dependent order', () => {
        // c0 ← c1 ← … ← cN (each cell's value feeds the next). Import-scale depth:
        // the pre-fix concat-based stack made this quadratic (17s of a 21s import).
        const n = 30000;
        const map: FormulaCellInfoMap = {};
        for (let i = 0; i < n; i++) {
            map[`c${i}`] = makeCell(`c${i}`, i < n - 1 ? [`c${i + 1}`] : []);
        }
        const result = getCalculationOrder([map.c0], map);
        expect(result).toHaveLength(n);
        const position = new Map(result.map((cell, index) => [cell.key, index]));
        for (let i = 0; i < n - 1; i++) {
            expect(position.get(`c${i}`)!).toBeLessThan(position.get(`c${i + 1}`)!);
        }
    });
});
