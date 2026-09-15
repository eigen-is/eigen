import { describe, expect, test } from 'bun:test';
import { createArrayResolver, type SheetData } from '../../engine/cell-resolver';
import { FormulaEngine, isFormula } from '../../engine/formula-engine';

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

// ─── Date results ───────────────────────────────────────────────────────────

describe('engine/formula-engine — date results', () => {
    const engine = new FormulaEngine();

    test('DATE yields the Excel serial, typed date', () => {
        const result = engine.evaluate('=DATE(2026,1,5)', 'sheet1', 0, 0, resolver);
        expect(result).toEqual({ value: 46027, display: '46027', type: 'date' });
    });

    test('date arithmetic stays a day count =DATE(2026,1,5)-DATE(2026,1,1)', () => {
        const result = engine.evaluate('=DATE(2026,1,5)-DATE(2026,1,1)', 'sheet1', 0, 0, resolver);
        expect(result.value).toBe(4);
        expect(result.type).toBe('number');
    });

    test('NOW yields a number, not a stringified Date', () => {
        const result = engine.evaluate('=NOW()', 'sheet1', 0, 0, resolver);
        expect(typeof result.value).toBe('number');
        expect(result.type).toBe('date');
    });
});

// ─── Range bounds ───────────────────────────────────────────────────────────

describe('engine/formula-engine — range bounds', () => {
    const engine = new FormulaEngine();

    test('whole-column =ROWS(A:A) counts the grid rows, not one past', () => {
        expect(engine.evaluate('=ROWS(A:A)', 'sheet1', 0, 0, resolver).value).toBe(2);
    });

    test('whole-row =COLUMNS(1:1) counts the grid columns, not one past', () => {
        expect(engine.evaluate('=COLUMNS(1:1)', 'sheet1', 0, 0, resolver).value).toBe(3);
    });

    test('=COUNTBLANK(A:A) sees no phantom cell past the grid', () => {
        expect(engine.evaluate('=COUNTBLANK(A:A)', 'sheet1', 0, 0, resolver).value).toBe(0);
    });

    test('explicit range clamps to the grid — =ROWS(A1:A100) is the grid row count', () => {
        expect(engine.evaluate('=ROWS(A1:A100)', 'sheet1', 0, 0, resolver).value).toBe(2);
    });

    test('=SUM over an oversized explicit range reads only the grid', () => {
        expect(engine.evaluate('=SUM(A1:ZZ20000)', 'sheet1', 0, 0, resolver).value).toBe(165);
    });

    test('=SUM over a full-sheet xlsx range completes', () => {
        // Unclamped, `A1:XFD1048576` is 17 billion cell reads — the pin is that it returns.
        expect(engine.evaluate('=SUM(A1:XFD1048576)', 'sheet1', 0, 0, resolver).value).toBe(165);
    });

    test('a range starting past the grid is empty, not a throw', () => {
        expect(engine.evaluate('=SUM(A9:B12)', 'sheet1', 0, 0, resolver).value).toBe(0);
    });
});
