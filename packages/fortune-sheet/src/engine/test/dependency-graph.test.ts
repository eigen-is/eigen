import { describe, expect, mock, test } from "bun:test";
import type { FormulaCellInfo, FormulaCellInfoMap } from "../../core/types";
import { detectCycle, getCalculationOrder, matchDependencies } from "../dependency-graph";

// Helper to build a minimal FormulaCellInfo for test use
function makeCell(key: string, parents: Record<string, number> = {}): FormulaCellInfo {
    return {
        key,
        r: 0,
        c: 0,
        id: "sheet1",
        calc_funcStr: "=A1",
        formulaDependency: [],
        parents,
        chidren: {},
        color: "w",
    };
}

// ─── getCalculationOrder ─────────────────────────────────────────────────────

describe("engine/dependency-graph — getCalculationOrder", () => {
    test("empty input returns empty list", () => {
        expect(getCalculationOrder([], {})).toEqual([]);
    });

    test("single formula with no dependencies returns it as-is", () => {
        const cell = makeCell("r0c0isheet1");
        const map: FormulaCellInfoMap = { "r0c0isheet1": cell };
        const result = getCalculationOrder([cell], map);
        expect(result).toHaveLength(1);
        expect(result[0].key).toBe("r0c0isheet1");
    });

    test("base cell comes before its dependent in the result", () => {
        // In this codebase, `parents[key] = 1` means "formula at key depends ON me".
        // So if A.parents = { B: 1 }, B depends on A → A must be evaluated first.
        const a = makeCell("r0c0isheet1");
        // B depends on A: set A.parents[B] = 1
        a.parents["r1c0isheet1"] = 1;
        const b = makeCell("r1c0isheet1");
        const map: FormulaCellInfoMap = {
            "r0c0isheet1": a,
            "r1c0isheet1": b,
        };

        const result = getCalculationOrder([a], map);
        expect(result).toHaveLength(2);
        const aIndex = result.findIndex((c) => c.key === "r0c0isheet1");
        const bIndex = result.findIndex((c) => c.key === "r1c0isheet1");
        // A (the base cell) must come before B (the dependent)
        expect(aIndex).toBeLessThan(bIndex);
    });

    test("chain A←B←C: C evaluates first, then B, then A", () => {
        // C is a base value; B.parents = { C: 1 } means C depends on B (B needs C's value).
        // Actually: A.parents[B] means B depends on A → A before B.
        // Build: C has no dependents, B depends on C (C.parents[B]=1), A depends on B (B.parents[A]=1)
        const c = makeCell("r2c0isheet1");
        const b = makeCell("r1c0isheet1");
        const a = makeCell("r0c0isheet1");
        c.parents["r1c0isheet1"] = 1; // B depends on C
        b.parents["r0c0isheet1"] = 1; // A depends on B
        const map: FormulaCellInfoMap = {
            "r0c0isheet1": a,
            "r1c0isheet1": b,
            "r2c0isheet1": c,
        };

        const result = getCalculationOrder([c], map);
        expect(result).toHaveLength(3);
        const keys = result.map((cell) => cell.key);
        expect(keys.indexOf("r2c0isheet1")).toBeLessThan(keys.indexOf("r1c0isheet1"));
        expect(keys.indexOf("r1c0isheet1")).toBeLessThan(keys.indexOf("r0c0isheet1"));
    });

    test("duplicate cells in input are only included once", () => {
        const cell = makeCell("r0c0isheet1");
        const map: FormulaCellInfoMap = { "r0c0isheet1": cell };
        const result = getCalculationOrder([cell, cell], map);
        expect(result).toHaveLength(1);
    });
});

// ─── matchDependencies ────────────────────────────────────────────────────────

describe("engine/dependency-graph — matchDependencies", () => {
    test("invokes callback for every cell in a single-cell range", () => {
        const calls: Array<[string, number, number, string]> = [];
        const dep = { row: [1, 1] as [number, number], column: [2, 2] as [number, number], sheetId: "s1" };

        matchDependencies({}, [dep], null, null, (key, r, c, sheetId) => {
            calls.push([key, r, c, sheetId]);
        });

        expect(calls).toHaveLength(1);
        expect(calls[0]).toEqual(["r1c2is1", 1, 2, "s1"]);
    });

    test("invokes callback for every cell in a multi-cell range", () => {
        const calls: string[] = [];
        const dep = { row: [0, 1] as [number, number], column: [0, 1] as [number, number], sheetId: "s1" };

        matchDependencies({}, [dep], null, null, (key) => {
            calls.push(key);
        });

        // 2×2 range → 4 cells
        expect(calls).toHaveLength(4);
        expect(calls).toContain("r0c0is1");
        expect(calls).toContain("r0c1is1");
        expect(calls).toContain("r1c0is1");
        expect(calls).toContain("r1c1is1");
    });

    test("uses cache on second call for the same range", () => {
        const cache: Record<string, any> = {};
        const dep = { row: [0, 0] as [number, number], column: [0, 0] as [number, number], sheetId: "s1" };
        const cellInfoMap: FormulaCellInfoMap = { "r0c0is1": makeCell("r0c0is1") };

        const calls: string[] = [];
        const func = (key: string) => calls.push(key);

        matchDependencies(cache, [dep], cellInfoMap, null, func);
        expect(calls).toHaveLength(1);

        // Second call should hit cache — same result, no re-iteration
        matchDependencies(cache, [dep], cellInfoMap, null, func);
        expect(calls).toHaveLength(2);
        expect(calls[0]).toBe(calls[1]);
    });

    test("does not populate cache when both maps are null", () => {
        const cache: Record<string, any> = {};
        const dep = { row: [0, 0] as [number, number], column: [0, 0] as [number, number], sheetId: "s1" };

        matchDependencies(cache, [dep], null, null, () => {});

        expect(Object.keys(cache)).toHaveLength(0);
    });
});

// ─── detectCycle ──────────────────────────────────────────────────────────────

describe("engine/dependency-graph — detectCycle", () => {
    test("empty map returns false", () => {
        expect(detectCycle({})).toBe(false);
    });

    test("single node with no parents returns false", () => {
        const map: FormulaCellInfoMap = { "r0c0is1": makeCell("r0c0is1") };
        expect(detectCycle(map)).toBe(false);
    });

    test("acyclic chain A→B→C returns false", () => {
        const map: FormulaCellInfoMap = {
            "r0c0is1": makeCell("r0c0is1", { "r1c0is1": 1 }),
            "r1c0is1": makeCell("r1c0is1", { "r2c0is1": 1 }),
            "r2c0is1": makeCell("r2c0is1"),
        };
        expect(detectCycle(map)).toBe(false);
    });

    test("direct self-cycle returns true", () => {
        const map: FormulaCellInfoMap = {
            "r0c0is1": makeCell("r0c0is1", { "r0c0is1": 1 }),
        };
        expect(detectCycle(map)).toBe(true);
    });

    test("two-node cycle A→B→A returns true", () => {
        const map: FormulaCellInfoMap = {
            "r0c0is1": makeCell("r0c0is1", { "r1c0is1": 1 }),
            "r1c0is1": makeCell("r1c0is1", { "r0c0is1": 1 }),
        };
        expect(detectCycle(map)).toBe(true);
    });

    test("indirect cycle A→B→C→A returns true", () => {
        const map: FormulaCellInfoMap = {
            "r0c0is1": makeCell("r0c0is1", { "r1c0is1": 1 }),
            "r1c0is1": makeCell("r1c0is1", { "r2c0is1": 1 }),
            "r2c0is1": makeCell("r2c0is1", { "r0c0is1": 1 }),
        };
        expect(detectCycle(map)).toBe(true);
    });

    test("disconnected acyclic graph with two components returns false", () => {
        const map: FormulaCellInfoMap = {
            "r0c0is1": makeCell("r0c0is1", { "r1c0is1": 1 }),
            "r1c0is1": makeCell("r1c0is1"),
            "r2c0is1": makeCell("r2c0is1", { "r3c0is1": 1 }),
            "r3c0is1": makeCell("r3c0is1"),
        };
        expect(detectCycle(map)).toBe(false);
    });
});
