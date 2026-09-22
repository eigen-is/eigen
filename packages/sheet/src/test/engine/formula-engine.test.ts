import { describe, expect, test } from 'bun:test';
import { createArrayResolver, type SheetData } from '../../engine/cell-resolver';
import { FormulaEngine, isFormula } from '../../engine/formula-engine';
import { functionCopy } from '../../engine/formula-shift';

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
        const result = engine.evaluate('=1+2', 'sheet1', resolver);
        expect(result.value).toBe(3);
        expect(result.type).toBe('number');
    });

    test('cell reference =A1', () => {
        const result = engine.evaluate('=A1', 'sheet1', resolver);
        expect(result.value).toBe(10);
        expect(result.type).toBe('number');
    });

    test('SUM function =SUM(A1:C1)', () => {
        const result = engine.evaluate('=SUM(A1:C1)', 'sheet1', resolver);
        expect(result.value).toBe(60);
        expect(result.type).toBe('number');
    });

    test('cross-cell arithmetic =A1+B1', () => {
        const result = engine.evaluate('=A1+B1', 'sheet1', resolver);
        expect(result.value).toBe(30);
        expect(result.type).toBe('number');
    });

    test('IF function =IF(A1>5,"yes","no")', () => {
        const result = engine.evaluate('=IF(A1>5,"yes","no")', 'sheet1', resolver);
        expect(result.value).toBe('yes');
        expect(result.type).toBe('string');
    });

    test('error for invalid formula', () => {
        const result = engine.evaluate('=UNKNOWNFUNC()', 'sheet1', resolver);
        expect(result.type).toBe('error');
    });

    test('referencing a string cell', () => {
        const result = engine.evaluate('=B2', 'sheet1', resolver);
        expect(result.value).toBe('hello');
        expect(result.type).toBe('string');
    });

    test('mixed arithmetic and cell ref =A2*2', () => {
        const result = engine.evaluate('=A2*2', 'sheet1', resolver);
        expect(result.value).toBe(10);
        expect(result.type).toBe('number');
    });
});

// ─── Date results ───────────────────────────────────────────────────────────

describe('engine/formula-engine — date results', () => {
    const engine = new FormulaEngine();

    test('DATE yields the Excel serial, typed date', () => {
        const result = engine.evaluate('=DATE(2026,1,5)', 'sheet1', resolver);
        expect(result).toEqual({ value: 46027, display: '46027', type: 'date' });
    });

    test('date arithmetic stays a day count =DATE(2026,1,5)-DATE(2026,1,1)', () => {
        const result = engine.evaluate('=DATE(2026,1,5)-DATE(2026,1,1)', 'sheet1', resolver);
        expect(result.value).toBe(4);
        expect(result.type).toBe('number');
    });

    test('NOW yields a number, not a stringified Date', () => {
        const result = engine.evaluate('=NOW()', 'sheet1', resolver);
        expect(typeof result.value).toBe('number');
        expect(result.type).toBe('date');
    });
});

// ─── Range bounds ───────────────────────────────────────────────────────────

describe('engine/formula-engine — range bounds', () => {
    const engine = new FormulaEngine();

    test('whole-column =ROWS(A:A) counts the grid rows, not one past', () => {
        expect(engine.evaluate('=ROWS(A:A)', 'sheet1', resolver).value).toBe(2);
    });

    test('whole-row =COLUMNS(1:1) counts the grid columns, not one past', () => {
        expect(engine.evaluate('=COLUMNS(1:1)', 'sheet1', resolver).value).toBe(3);
    });

    test('=COUNTBLANK(A:A) sees no phantom cell past the grid', () => {
        expect(engine.evaluate('=COUNTBLANK(A:A)', 'sheet1', resolver).value).toBe(0);
    });

    test('explicit range clamps to the grid — =ROWS(A1:A100) is the grid row count', () => {
        expect(engine.evaluate('=ROWS(A1:A100)', 'sheet1', resolver).value).toBe(2);
    });

    test('=SUM over an oversized explicit range reads only the grid', () => {
        expect(engine.evaluate('=SUM(A1:ZZ20000)', 'sheet1', resolver).value).toBe(165);
    });

    test('=SUM over a full-sheet xlsx range completes', () => {
        // Unclamped, `A1:XFD1048576` is 17 billion cell reads — the pin is that it returns.
        expect(engine.evaluate('=SUM(A1:XFD1048576)', 'sheet1', resolver).value).toBe(165);
    });

    test('a range starting past the grid is empty, not a throw', () => {
        expect(engine.evaluate('=SUM(A9:B12)', 'sheet1', resolver).value).toBe(0);
    });
});

describe('engine/formula-engine — compiled formula at an offset', () => {
    const engine = new FormulaEngine();
    const at = (formula: string, rowOffset: number, colOffset: number) =>
        engine.evaluateCompiled(engine.compile(formula), 'sheet1', resolver, rowOffset, colOffset).value;

    test('relative legs move, $ legs stay', () => {
        expect(at('=A1', 1, 2)).toBe(100);
        expect(at('=$A1', 1, 2)).toBe(5);
        expect(at('=A$1', 1, 2)).toBe(30);
        expect(at('=$A$1', 1, 2)).toBe(10);
        expect(at('=SUM($A$1:A1)', 0, 2)).toBe(60);
    });

    test('a reversed range stays where it is, as the text shifter leaves it', () => {
        expect(at('=SUM(B1:A1)', 1, 0)).toBe(30);
    });

    test('a leg moved off the sheet is #REF!', () => {
        expect(at('=A1', -1, 0)).toBe('#REF!');
    });

    test('one compiled formula serves many offsets', () => {
        const compiled = engine.compile('=A1*2');
        const values = [0, 1, 2].map((c) => engine.evaluateCompiled(compiled, 'sheet1', resolver, 0, c).value);
        expect(values).toEqual([20, 40, 60]);
    });

    // A 5×5 grid of distinct powers of two, so every range sum names its cells.
    const grid = createArrayResolver([
        {
            id: 'grid',
            name: 'Grid',
            data: Array.from({ length: 5 }, (_, r) =>
                Array.from({ length: 5 }, (_, c) => ({ v: 2 ** (r * 5 + c), ct: { t: 'n', fa: 'General' } })),
            ),
            calculationChain: [],
            dynamicArrayCompute: [],
        },
    ]);
    const onGrid = (formula: string, rowOffset: number, colOffset: number) =>
        engine.evaluateCompiled(engine.compile(formula), 'grid', grid, rowOffset, colOffset).value;
    // What paste and autofill evaluate: the formula text shifted by functionCopy.
    const shifted = (formula: string, rowOffset: number, colOffset: number) => {
        const down = `=${functionCopy(formula, 'down', rowOffset)}`;
        return engine.evaluate(`=${functionCopy(down, 'right', colOffset)}`, 'grid', grid).value;
    };

    // functionCopy, one axis at a time, stops at the range its first step reversed; Excel moves both axes at once.
    test('a range whose legs shift differently reads B4:B$1 for A1:A$1 at (3,1)', () => {
        expect(onGrid('=SUM(A1:A$1)', 3, 1)).toBe(2 ** 1 + 2 ** 6 + 2 ** 11 + 2 ** 16);
    });

    test('a relative leg that crosses its $ leg reads D3:$B$2 for A1:$B$2 at (2,3)', () => {
        expect(onGrid('=SUM(A1:$B$2)', 2, 3)).toBe(2 ** 6 + 2 ** 7 + 2 ** 8 + 2 ** 11 + 2 ** 12 + 2 ** 13);
    });

    test('an offset past the last row and column reads empty cells, not an error', () => {
        expect(onGrid('=SUM(A1:B2)', 10, 10)).toBe(0);
        expect(onGrid('=A1', 5, 0)).toBe(shifted('=A1', 5, 0));
        expect(onGrid('=A1', 0, 5)).toBe(shifted('=A1', 0, 5));
    });
});
