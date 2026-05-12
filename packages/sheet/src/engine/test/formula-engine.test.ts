import { describe, expect, test } from 'bun:test';
import { createArrayResolver, type SheetData } from '../cell-resolver';
import { FormulaEngine, isCellReference, isFormula } from '../formula-engine';

const sheets: SheetData[] = [
    {
        id: 'sheet1',
        name: 'Sheet1',
        data: [
            [
                { v: 10, m: '10', ct: { t: 'n', fa: 'General' } },
                { v: 20, m: '20', ct: { t: 'n', fa: 'General' } },
                { v: 30, m: '30', ct: { t: 'n', fa: 'General' } },
            ],
            [
                { v: 5, m: '5', ct: { t: 'n', fa: 'General' } },
                { v: 'hello', m: 'hello', ct: { t: 's', fa: 'General' } },
                { v: 100, m: '100', ct: { t: 'n', fa: 'General' } },
            ],
        ],
        calculationChain: [],
        dynamicArrayCompute: [],
    },
];

const resolver = createArrayResolver(sheets);

// ─── isFormula ───────────────────────────────────────────────────────────────

describe('engine/formula-engine — isFormula', () => {
    test('recognizes =SUM(A1:A3)', () => {
        expect(isFormula('=SUM(A1:A3)')).toBe(true);
    });

    test('recognizes =1+1', () => {
        expect(isFormula('=1+1')).toBe(true);
    });

    test('rejects plain string', () => {
        expect(isFormula('hello')).toBe(false);
    });

    test('rejects lone equals sign', () => {
        expect(isFormula('=')).toBe(false);
    });

    test('rejects number', () => {
        expect(isFormula(42)).toBe(false);
    });

    test('rejects null', () => {
        expect(isFormula(null)).toBe(false);
    });

    test('rejects undefined', () => {
        expect(isFormula(undefined)).toBe(false);
    });
});

// ─── isCellReference ────────────────────────────────────────────────────────

describe('engine/formula-engine — isCellReference', () => {
    test('recognizes A1', () => {
        expect(isCellReference('A1')).toBe(true);
    });

    test('recognizes $B$3', () => {
        expect(isCellReference('$B$3')).toBe(true);
    });

    test('recognizes AA100', () => {
        expect(isCellReference('AA100')).toBe(true);
    });

    test('recognizes range A1:B3', () => {
        expect(isCellReference('A1:B3')).toBe(true);
    });

    test('recognizes Sheet1!A1', () => {
        expect(isCellReference('Sheet1!A1')).toBe(true);
    });

    test('rejects plain string', () => {
        expect(isCellReference('hello')).toBe(false);
    });

    test('rejects bare number', () => {
        expect(isCellReference('123')).toBe(false);
    });

    test('rejects empty string', () => {
        expect(isCellReference('')).toBe(false);
    });
});

// ─── FormulaEngine.evaluate ─────────────────────────────────────────────────

describe('engine/formula-engine — FormulaEngine.evaluate', () => {
    const engine = new FormulaEngine();

    test('simple arithmetic =1+2', () => {
        const result = engine.evaluate('=1+2', 'sheet1', 0, 0, resolver);
        expect(result.value).toBe(3);
        expect(result.type).toBe('number');
    });

    test('cell reference =A1', () => {
        const result = engine.evaluate('=A1', 'sheet1', 0, 1, resolver);
        expect(result.value).toBe(10);
        expect(result.type).toBe('number');
    });

    test('SUM function =SUM(A1:C1)', () => {
        const result = engine.evaluate('=SUM(A1:C1)', 'sheet1', 0, 0, resolver);
        expect(result.value).toBe(60);
        expect(result.type).toBe('number');
    });

    test('cross-cell arithmetic =A1+B1', () => {
        const result = engine.evaluate('=A1+B1', 'sheet1', 0, 0, resolver);
        expect(result.value).toBe(30);
        expect(result.type).toBe('number');
    });

    test('IF function =IF(A1>5,"yes","no")', () => {
        const result = engine.evaluate('=IF(A1>5,"yes","no")', 'sheet1', 0, 0, resolver);
        expect(result.value).toBe('yes');
        expect(result.type).toBe('string');
    });

    test('error for invalid formula', () => {
        const result = engine.evaluate('=UNKNOWNFUNC()', 'sheet1', 0, 0, resolver);
        expect(result.type).toBe('error');
    });

    test('referencing a string cell', () => {
        const result = engine.evaluate('=B2', 'sheet1', 0, 0, resolver);
        expect(result.value).toBe('hello');
        expect(result.type).toBe('string');
    });

    test('mixed arithmetic and cell ref =A2*2', () => {
        const result = engine.evaluate('=A2*2', 'sheet1', 0, 0, resolver);
        expect(result.value).toBe(10);
        expect(result.type).toBe('number');
    });
});

// ─── FormulaEngine.evaluateAll ──────────────────────────────────────────────

describe('engine/formula-engine — FormulaEngine.evaluateAll', () => {
    test('processes multiple formulas with intermediate caching', () => {
        const engine = new FormulaEngine();
        const cells = [
            { r: 2, c: 0, id: 'sheet1', f: '=A1+A2' },
            { r: 2, c: 1, id: 'sheet1', f: '=A3*2' },
        ];

        const results = engine.evaluateAll(cells, resolver);

        // First formula: A1(10) + A2(5) = 15
        const first = results.get('2_0_sheet1');
        expect(first).toBeDefined();
        expect(first!.value).toBe(15);

        // Second formula: A3 should pick up the cached result (15) from the first evaluation
        const second = results.get('2_1_sheet1');
        expect(second).toBeDefined();
        expect(second!.value).toBe(30);

        // Clean up for other tests
        engine.resetState();
    });

    test('returns a Map with correct keys', () => {
        const engine = new FormulaEngine();
        const cells = [{ r: 0, c: 3, id: 'sheet1', f: '=1+1' }];

        const results = engine.evaluateAll(cells, resolver);
        expect(results.size).toBe(1);
        expect(results.has('0_3_sheet1')).toBe(true);
    });
});

// ─── FormulaEngine.getDependencies ──────────────────────────────────────────

describe('engine/formula-engine — FormulaEngine.getDependencies', () => {
    const engine = new FormulaEngine();

    test('single cell reference', () => {
        const deps = engine.getDependencies('=A1', 'sheet1');
        expect(deps).toHaveLength(1);
        expect(deps[0].row).toEqual([0, 0]);
        expect(deps[0].column).toEqual([0, 0]);
    });

    test('range reference', () => {
        const deps = engine.getDependencies('=SUM(A1:C2)', 'sheet1');
        expect(deps).toHaveLength(1);
        expect(deps[0].row).toEqual([0, 1]);
        expect(deps[0].column).toEqual([0, 2]);
    });

    test('multiple references', () => {
        const deps = engine.getDependencies('=A1+B2', 'sheet1');
        expect(deps).toHaveLength(2);
    });

    test('no dependencies for pure arithmetic', () => {
        const deps = engine.getDependencies('=1+2', 'sheet1');
        expect(deps).toHaveLength(0);
    });
});

// ─── FormulaEngine.format ───────────────────────────────────────────────────

describe('engine/formula-engine — FormulaEngine.format', () => {
    const engine = new FormulaEngine();

    test('formats number with decimal places', () => {
        expect(engine.format(1.5, '0.00')).toBe('1.50');
    });

    test('formats number with thousands separator', () => {
        expect(engine.format(1234567, '#,##0')).toBe('1,234,567');
    });

    test('formats General', () => {
        expect(engine.format(42, 'General')).toBe('42');
    });

    test('formats percentage', () => {
        expect(engine.format(0.25, '0%')).toBe('25%');
    });
});

// ─── FormulaEngine.resetState ───────────────────────────────────────────────

describe('engine/formula-engine — FormulaEngine.resetState', () => {
    test('clears cached data', () => {
        const engine = new FormulaEngine();
        engine.state.execFunctionGlobalData['test'] = { v: 1 };
        engine.resetState();
        expect(engine.state.execFunctionGlobalData).toEqual({});
    });
});
