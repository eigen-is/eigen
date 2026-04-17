import { describe, expect, test } from "bun:test";
import { FormulaEngine } from "../formula-engine";
import { createArrayResolver } from "../cell-resolver";

// ─── FormulaEngine.recalculateAll ──────────────────────────────────────────

describe("engine/formula-engine — recalculateAll", () => {
    test("simple chain: A1=10, B1=20, C1=A1+B1, A2=C1*2", () => {
        const engine = new FormulaEngine();
        const resolver = createArrayResolver([
            {
                id: "s1",
                name: "Sheet1",
                data: [
                    [
                        { v: 10, ct: { t: "n", fa: "General" } },
                        { v: 20, ct: { t: "n", fa: "General" } },
                        { f: "=A1+B1", ct: { t: "n", fa: "General" } },
                    ],
                    [
                        { f: "=C1*2", ct: { t: "n", fa: "General" } },
                        null,
                        null,
                    ],
                ],
                calculationChain: [
                    { r: 0, c: 2, id: "s1" },
                    { r: 1, c: 0, id: "s1" },
                ],
                dynamicArrayCompute: [],
            },
        ]);

        const results = engine.recalculateAll(resolver);

        expect(results.get("0_2_s1")?.value).toBe(30);
        expect(results.get("1_0_s1")?.value).toBe(60);
    });

    test("no dependencies: A1=1+2+3", () => {
        const engine = new FormulaEngine();
        const resolver = createArrayResolver([
            {
                id: "s1",
                name: "Sheet1",
                data: [
                    [{ f: "=1+2+3", ct: { t: "n", fa: "General" } }],
                ],
                calculationChain: [{ r: 0, c: 0, id: "s1" }],
                dynamicArrayCompute: [],
            },
        ]);

        const results = engine.recalculateAll(resolver);

        expect(results.size).toBe(1);
        expect(results.get("0_0_s1")?.value).toBe(6);
    });

    test("cross-sheet: Sheet1!A1=42, Sheet2!A1=Sheet1!A1*3", () => {
        const engine = new FormulaEngine();
        const resolver = createArrayResolver([
            {
                id: "s1",
                name: "Sheet1",
                data: [
                    [{ v: 42, ct: { t: "n", fa: "General" } }],
                ],
                calculationChain: [],
                dynamicArrayCompute: [],
            },
            {
                id: "s2",
                name: "Sheet2",
                data: [
                    [{ f: "=Sheet1!A1*3", ct: { t: "n", fa: "General" } }],
                ],
                calculationChain: [{ r: 0, c: 0, id: "s2" }],
                dynamicArrayCompute: [],
            },
        ]);

        const results = engine.recalculateAll(resolver);

        expect(results.size).toBe(1);
        expect(results.get("0_0_s2")?.value).toBe(126);
    });

    test("empty: no formulas returns empty map", () => {
        const engine = new FormulaEngine();
        const resolver = createArrayResolver([
            {
                id: "s1",
                name: "Sheet1",
                data: [
                    [{ v: 1, ct: { t: "n", fa: "General" } }],
                ],
                calculationChain: [],
                dynamicArrayCompute: [],
            },
        ]);

        const results = engine.recalculateAll(resolver);

        expect(results.size).toBe(0);
    });

    test("SUM range: A1=1, B1=2, C1=3, A2=SUM(A1:C1)", () => {
        const engine = new FormulaEngine();
        const resolver = createArrayResolver([
            {
                id: "s1",
                name: "Sheet1",
                data: [
                    [
                        { v: 1, ct: { t: "n", fa: "General" } },
                        { v: 2, ct: { t: "n", fa: "General" } },
                        { v: 3, ct: { t: "n", fa: "General" } },
                    ],
                    [
                        { f: "=SUM(A1:C1)", ct: { t: "n", fa: "General" } },
                        null,
                        null,
                    ],
                ],
                calculationChain: [{ r: 1, c: 0, id: "s1" }],
                dynamicArrayCompute: [],
            },
        ]);

        const results = engine.recalculateAll(resolver);

        expect(results.size).toBe(1);
        expect(results.get("1_0_s1")?.value).toBe(6);
    });

    test("three-deep chain: A1=5, B1=A1+1, C1=B1+1, D1=C1+1", () => {
        const engine = new FormulaEngine();
        const resolver = createArrayResolver([
            {
                id: "s1",
                name: "Sheet1",
                data: [
                    [
                        { v: 5, ct: { t: "n", fa: "General" } },
                        { f: "=A1+1", ct: { t: "n", fa: "General" } },
                        { f: "=B1+1", ct: { t: "n", fa: "General" } },
                        { f: "=C1+1", ct: { t: "n", fa: "General" } },
                    ],
                ],
                calculationChain: [
                    { r: 0, c: 1, id: "s1" },
                    { r: 0, c: 2, id: "s1" },
                    { r: 0, c: 3, id: "s1" },
                ],
                dynamicArrayCompute: [],
            },
        ]);

        const results = engine.recalculateAll(resolver);

        expect(results.get("0_1_s1")?.value).toBe(6);
        expect(results.get("0_2_s1")?.value).toBe(7);
        expect(results.get("0_3_s1")?.value).toBe(8);
    });

    test("error handling: =1/0 returns error type", () => {
        const engine = new FormulaEngine();
        const resolver = createArrayResolver([
            {
                id: "s1",
                name: "Sheet1",
                data: [
                    [{ f: "=1/0", ct: { t: "n", fa: "General" } }],
                ],
                calculationChain: [{ r: 0, c: 0, id: "s1" }],
                dynamicArrayCompute: [],
            },
        ]);

        const results = engine.recalculateAll(resolver);

        expect(results.size).toBe(1);
        expect(results.get("0_0_s1")?.type).toBe("error");
    });

    test("resets state before recalculating", () => {
        const engine = new FormulaEngine();
        // Pollute state with stale data
        engine.state.execFunctionGlobalData["0_0_s1"] = { v: 999, ct: { t: "n", fa: "General" } };

        const resolver = createArrayResolver([
            {
                id: "s1",
                name: "Sheet1",
                data: [
                    [{ f: "=1+1", ct: { t: "n", fa: "General" } }],
                ],
                calculationChain: [{ r: 0, c: 0, id: "s1" }],
                dynamicArrayCompute: [],
            },
        ]);

        const results = engine.recalculateAll(resolver);

        expect(results.get("0_0_s1")?.value).toBe(2);
    });
});
