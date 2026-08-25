import { describe, expect, test } from 'bun:test';
import { getCalculationOrder } from '../../engine/dependency-graph';
import type { FormulaCellInfo, FormulaCellInfoMap } from '../../engine/types';

// Helper to build a minimal FormulaCellInfo for test use
function makeCell(key: string, parents: Record<string, number> = {}): FormulaCellInfo {
    return {
        key,
        r: 0,
        c: 0,
        id: 'sheet1',
        calc_funcStr: '=A1',
        formulaDependency: [],
        parents,
        chidren: {},
        color: 'w',
    };
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
        // In this codebase, `parents[key] = 1` means "formula at key depends ON me".
        // So if A.parents = { B: 1 }, B depends on A → A must be evaluated first.
        const a = makeCell('r0c0isheet1');
        // B depends on A: set A.parents[B] = 1
        a.parents['r1c0isheet1'] = 1;
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
        // C is a base value; B.parents = { C: 1 } means C depends on B (B needs C's value).
        // Actually: A.parents[B] means B depends on A → A before B.
        // Build: C has no dependents, B depends on C (C.parents[B]=1), A depends on B (B.parents[A]=1)
        const c = makeCell('r2c0isheet1');
        const b = makeCell('r1c0isheet1');
        const a = makeCell('r0c0isheet1');
        c.parents['r1c0isheet1'] = 1; // B depends on C
        b.parents['r0c0isheet1'] = 1; // A depends on B
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
        // A hub many formulas read: hub.parents lists every dependent.
        const n = 5000;
        const hub = makeCell('hub');
        const map: FormulaCellInfoMap = { hub };
        for (let i = 0; i < n; i++) {
            const key = `dep${i}`;
            map[key] = makeCell(key);
            hub.parents[key] = 1;
        }
        const result = getCalculationOrder([hub], map);
        expect(result).toHaveLength(n + 1);
        expect(result[0].key).toBe('hub');
    });

    test('cyclic graph terminates and yields every node exactly once', () => {
        // Spreadsheets do contain circular references; recalc.ts relies on the sort
        // being cycle-tolerant by construction (no throw, no hang).
        const a = makeCell('a');
        const b = makeCell('b');
        const c = makeCell('c');
        a.parents.b = 1;
        b.parents.c = 1;
        c.parents.a = 1;
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
            map[`c${i}`] = makeCell(`c${i}`);
        }
        for (let i = 0; i < n - 1; i++) {
            map[`c${i}`].parents[`c${i + 1}`] = 1;
        }
        const result = getCalculationOrder([map.c0], map);
        expect(result).toHaveLength(n);
        const position = new Map(result.map((cell, index) => [cell.key, index]));
        for (let i = 0; i < n - 1; i++) {
            expect(position.get(`c${i}`)!).toBeLessThan(position.get(`c${i + 1}`)!);
        }
    });
});
