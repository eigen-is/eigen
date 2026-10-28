import { describe, expect, test } from 'bun:test';
import type { SheetData } from '../../engine/cell-resolver';
import { createArrayResolver } from '../../engine/cell-resolver';
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

    test('an array result keeps its top-left value, as a spill anchor does =B1:C2', () => {
        expect(engine.evaluate('=B1:C2', 'sheet1', resolver)).toEqual({ value: 20, display: '20', type: 'number' });
        expect(engine.evaluate('=TRANSPOSE(B1:B2)', 'sheet1', resolver).value).toBe(20);
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

    test('a reversed range shifts as its sorted twin, as the text shifter does', () => {
        expect(at('=SUM(B1:A1)', 1, 0)).toBe(5);
        expect(functionCopy('=SUM(B1:A1)', 1, 0)).toBe('SUM(A2:B2)');
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
    const shifted = (formula: string, rowOffset: number, colOffset: number) =>
        engine.evaluate(`=${functionCopy(formula, rowOffset, colOffset)}`, 'grid', grid).value;

    test('a range whose legs shift differently reads B4:B$1 for A1:A$1 at (3,1)', () => {
        const expected = 2 ** 1 + 2 ** 6 + 2 ** 11 + 2 ** 16;
        expect(onGrid('=SUM(A1:A$1)', 3, 1)).toBe(expected);
        expect(shifted('=SUM(A1:A$1)', 3, 1)).toBe(expected);
    });

    test('a relative leg that crosses its $ leg reads D3:$B$2 for A1:$B$2 at (2,3)', () => {
        const expected = 2 ** 6 + 2 ** 7 + 2 ** 8 + 2 ** 11 + 2 ** 12 + 2 ** 13;
        expect(onGrid('=SUM(A1:$B$2)', 2, 3)).toBe(expected);
        expect(shifted('=SUM(A1:$B$2)', 2, 3)).toBe(expected);
    });

    test('shifted formula text evaluates to the compiled formula at the same offset', () => {
        const formulas = [
            '=A1',
            '=$A1+A$1',
            '=SUM(A1:B2)',
            '=SUM(A1:A$1)',
            '=SUM(A1:$B$2)',
            '=SUM($A1:B$3)',
            '=SUM($C$3:E5)',
            '=SUM(B:C)',
            '=SUM($B:C)',
            '=SUM(2:3)',
            '=SUM($2:$3)',
            '=SUM(Grid!A1:$C$2)',
            '=SUM(B2:B2)*C3',
        ];
        const offsets = [-3, -1, 0, 1, 2, 3];
        for (const formula of formulas) {
            for (const rowOffset of offsets) {
                for (const colOffset of offsets) {
                    const label = `${formula} at (${rowOffset},${colOffset})`;
                    expect([label, shifted(formula, rowOffset, colOffset)]).toEqual([
                        label,
                        onGrid(formula, rowOffset, colOffset),
                    ]);
                }
            }
        }
    });

    test('an offset past the last row and column reads empty cells, not an error', () => {
        expect(onGrid('=SUM(A1:B2)', 10, 10)).toBe(0);
        expect(onGrid('=A1', 5, 0)).toBe(shifted('=A1', 5, 0));
        expect(onGrid('=A1', 0, 5)).toBe(shifted('=A1', 0, 5));
    });
});

// ─── An error held in a cell ────────────────────────────────────────────────

describe('engine/formula-engine — an error held in a cell', () => {
    const engine = new FormulaEngine();
    // A cell holding an error, as the editor and recalc write one.
    const failed = (v: string) => ({ f: '=X', v, m: v, ct: { fa: 'General', t: 'e' } });
    const number = (v: number) => ({ v, m: String(v), ct: { fa: 'General', t: 'n' } });
    const text = (v: string) => ({ v, m: v, ct: { fa: 'General', t: 's' } });
    const errors = ['#NULL!', '#DIV/0!', '#VALUE!', '#REF!', '#NUM!', '#N/A'];
    const errorResolver = createArrayResolver([
        {
            id: 'errors',
            name: 'Errors',
            data: [
                // Row 1: an error per column, Excel's ERROR.TYPE order but #NAME?, which the test below pins apart.
                errors.map(failed),
                // Rows 2–4: a column of numbers with an error inside, a lookup table whose match holds an error, and
                // one bit per row.
                [number(1), text('a'), number(1), number(2)],
                [failed('#DIV/0!'), text('b'), failed('#N/A'), number(4)],
                [number(3), text('c'), number(3), number(8)],
                // Row 5: a cell holding the text #DIV/0!, typed with a leading apostrophe, and a #NAME?.
                [{ v: '#DIV/0!', m: '#DIV/0!', ct: { fa: '@', t: 's' }, qp: 1 }, failed('#NAME?')],
                // Row 6: the errors formulajs has no object for, and a rich-text cell whose runs read #N/A.
                [
                    failed('#SPILL!'),
                    failed('#ERROR!'),
                    failed('#CALC!'),
                    { ct: { fa: 'General', t: 'inlineStr', s: [{ v: '#N/' }, { v: 'A', bl: 1 }] } },
                ],
                // Row 7: one bit per column under row 1's errors, so a sum names the columns it matched.
                [1, 2, 4, 8, 16, 32].map(number),
            ],
            calculationChain: [],
            dynamicArrayCompute: [],
        },
        { id: 'other', name: 'Other', data: [[failed('#N/A')]], calculationChain: [], dynamicArrayCompute: [] },
    ]);
    const evaluate = (formula: string) => engine.evaluate(formula, 'errors', errorResolver).value;
    const columns = ['A', 'B', 'C', 'D', 'E', 'F'];

    test('ISERROR, ISERR, ISNA and ERROR.TYPE see each error a cell holds, as Excel does', () => {
        expect(columns.map((c) => evaluate(`=ISERROR(${c}1)`))).toEqual([true, true, true, true, true, true]);
        expect(columns.map((c) => evaluate(`=ISERR(${c}1)`))).toEqual([true, true, true, true, true, false]);
        expect(columns.map((c) => evaluate(`=ISNA(${c}1)`))).toEqual([false, false, false, false, false, true]);
        expect(columns.map((c) => evaluate(`=ERROR.TYPE(${c}1)`))).toEqual([1, 2, 3, 4, 6, 7]);
    });

    test('IFERROR traps each error a cell holds, and IFNA only #N/A', () => {
        expect(columns.map((c) => evaluate(`=IFERROR(${c}1,"none")`))).toEqual(errors.map(() => 'none'));
        expect(columns.map((c) => evaluate(`=IFNA(${c}1,"none")`))).toEqual([...errors.slice(0, 5), 'none']);
    });

    test('an operator and a function hand a referenced error on', () => {
        expect(engine.evaluate('=B1+1', 'errors', errorResolver)).toEqual({
            value: '#DIV/0!',
            display: '#DIV/0!',
            type: 'error',
        });
        expect(evaluate('=-F1')).toBe('#N/A');
        expect(evaluate('=ABS(C1)')).toBe('#VALUE!');
        expect(evaluate('=B1:C1')).toBe('#DIV/0!');
    });

    test('a range with an error inside gives the error, which IFERROR traps', () => {
        expect(evaluate('=SUM(A2:A4)')).toBe('#DIV/0!');
        expect(evaluate('=IFERROR(SUM(A2:A4),0)')).toBe(0);
    });

    test('a lookup that returns an error cell returns its error', () => {
        expect(evaluate('=VLOOKUP("b",B2:C4,2,FALSE)')).toBe('#N/A');
        expect(evaluate('=IFNA(VLOOKUP("b",B2:C4,2,FALSE),"none")')).toBe('none');
        expect(evaluate('=ISNA(INDEX(C2:C4,2))')).toBe(true);
    });

    test('an error held on another sheet is one too', () => {
        expect(evaluate('=ISNA(Other!A1)')).toBe(true);
        expect(evaluate('=IFERROR(\'Other\'!A1,"none")')).toBe('none');
    });

    test('a cell holding the text #DIV/0! stays text', () => {
        expect(evaluate('=ISERROR(A5)')).toBe(false);
        expect(evaluate('=ISTEXT(A5)')).toBe(true);
        expect(evaluate('=LEN(A5)')).toBe(7);
        expect(evaluate('=IFERROR(A5,"none")')).toBe('#DIV/0!');
        expect(evaluate('=ERROR.TYPE(A5)')).toBe('#N/A');
    });

    test('a text result that starts with # is text, not an error', () => {
        expect(engine.evaluate('="#tag"', 'errors', errorResolver)).toEqual({
            value: '#tag',
            display: '#tag',
            type: 'string',
        });
    });

    // A cell's #NAME? may be the stand-in for a value Excel computed with a function the engine lacks, and the cell
    // can't tell. So it is handed on, as that function's own #NAME? is, and no fallback reads as Excel's answer.
    test('a #NAME? a cell holds is handed on, as the #NAME? of a function the engine lacks is', () => {
        for (const formula of ['=ISERROR(B5)', '=IFERROR(B5,"none")', '=ERROR.TYPE(B5)', '=ISNA(B5)', '=B5+1']) {
            expect([formula, evaluate(formula)]).toEqual([formula, '#NAME?']);
        }
        expect(evaluate('=IF(TRUE,1,B5)')).toBe(1);
        expect(evaluate('=IFERROR(SUM(A5:B5),0)')).toBe('#NAME?');
    });

    test('an operator hands on the first error in a range operand', () => {
        expect(evaluate('=C3:C4&"a"')).toBe('#N/A');
        expect(evaluate('=A2:A4+1')).toBe('#DIV/0!');
    });

    test('a function hands on the first error in its arguments, ranges included, as Excel does', () => {
        expect(evaluate('=CONCAT(A2:A4)')).toBe('#DIV/0!');
        expect(evaluate('=CONCATENATE("a",F1)')).toBe('#N/A');
        expect(evaluate('=TEXTJOIN(",",TRUE,C2:C4)')).toBe('#N/A');
        expect(evaluate('=IFERROR(CONCAT(A2:A4),"none")')).toBe('none');
        expect(evaluate('=STDEV(A2:A4)')).toBe('#DIV/0!');
        expect(evaluate('=VARA(A2:A4)')).toBe('#DIV/0!');
        expect(evaluate('=ISEVEN(F1)')).toBe('#N/A');
        expect(evaluate('=IF(F1,1,2)')).toBe('#N/A');
        expect(evaluate('=VLOOKUP(F1,B2:C4,2,FALSE)')).toBe('#N/A');
    });

    test('a function that reads past an error, such as COUNT or a lookup, does not hand it on', () => {
        expect(evaluate('=COUNT(A2:A4)')).toBe(2);
        expect(evaluate('=COUNTA(A2:A4)')).toBe(3);
        expect(evaluate('=COUNTBLANK(A2:A4)')).toBe(0);
        expect(evaluate('=VLOOKUP("a",B2:C4,2,FALSE)')).toBe(1);
        expect(evaluate('=MATCH(3,A2:A4,0)')).toBe(3);
        expect(evaluate('=INDEX(A2:A4,3)')).toBe(3);
        expect(evaluate('=ROWS(A2:A4)')).toBe(3);
        expect(evaluate('=TRANSPOSE(A2:A4)')).toBe(1);
        expect(evaluate('=TYPE(F1)')).toBe(16);
        expect(evaluate('=ISTEXT(F1)')).toBe(false);
        expect(evaluate('=IF(TRUE,1,F1)')).toBe(1);
    });

    test('COUNTIF and its family match an error cell by the text it shows', () => {
        expect(evaluate('=COUNTIF(A1:F1,"#N/A")')).toBe(1);
        expect(evaluate('=COUNTIF(A1:F1,"#DIV/0!")')).toBe(1);
        expect(evaluate('=COUNTIFS(A1:F1,"#N/A",A1:F1,"<>#DIV/0!")')).toBe(1);
        expect(evaluate('=SUMIF(A2:A4,">0")')).toBe(4);
        expect(evaluate('=SUMIF(C2:C4,"<>#N/A",A2:A4)')).toBe(4);
        expect(evaluate('=MAXIFS(A2:A4,C2:C4,"<>#N/A")')).toBe(3);
        expect(evaluate('=MINIFS(C2:C4,A2:A4,"<>#DIV/0!")')).toBe(1);
        expect(evaluate('=MAXIFS(A2:C2,A3:C3,"#N/A")')).toBe(1);
    });

    test('an error criterion matches the error cells it names, as Excel does', () => {
        expect(evaluate('=COUNTIF(A1:F1,F1)')).toBe(1);
        expect(evaluate('=COUNTIF(A1:F1,NA())')).toBe(1);
        expect(evaluate('=COUNTIFS(A1:F1,B1,A7:F7,">0")')).toBe(1);
        expect(evaluate('=SUMIF(A1:F1,F1,A7:F7)')).toBe(32);
        expect(evaluate('=SUMIFS(A7:F7,A1:F1,B1)')).toBe(2);
        expect(evaluate('=AVERAGEIF(A1:F1,NA(),A7:F7)')).toBe(32);
        // formulajs's AVERAGEIFS reads a criteria range down a column only.
        expect(evaluate('=AVERAGEIFS(D2:D4,C2:C4,C3)')).toBe(4);
        expect(evaluate('=MAXIFS(A7:F7,A1:F1,F1)')).toBe(32);
        expect(evaluate('=MINIFS(A7:F7,A1:F1,B1)')).toBe(2);
    });

    test('UNIQUE, FLATTEN and COUNTUNIQUE read past an error in their range', () => {
        expect(evaluate('=UNIQUE(A2:A4)')).toBe(1);
        expect(evaluate('=FLATTEN(A2:A4)')).toBe(1);
        expect(evaluate('=COUNTUNIQUE(A2:A4)')).toBe(3);
    });

    test('a lookup hands on an error in its options, where it reads past one in its table', () => {
        expect(evaluate('=VLOOKUP("a",B2:C4,2,F1)')).toBe('#N/A');
        expect(evaluate('=HLOOKUP("a",A2:C4,2,B1)')).toBe('#DIV/0!');
        expect(evaluate('=INDEX(A7:F7,F1)')).toBe('#N/A');
        expect(evaluate('=MATCH(3,A2:A4,B1)')).toBe('#DIV/0!');
        expect(evaluate('=XMATCH(3,A2:A4,B1)')).toBe('#DIV/0!');
        expect(evaluate('=XLOOKUP(3,A2:A4,C2:C4,"none",B1)')).toBe('#DIV/0!');
        expect(evaluate('=XLOOKUP(3,A2:A4,C2:C4,F1)')).toBe(3);
        expect(evaluate('=XLOOKUP(9,A2:A4,C2:C4,F1)')).toBe('#N/A');
        expect(evaluate('=LOOKUP(3,A2:A4,C2:C4)')).toBe(3);
    });

    test('IFS and SWITCH hand on an error they reach, and not one past the value they return', () => {
        expect(evaluate('=IFS(F1>0,1,TRUE,2)')).toBe('#N/A');
        expect(evaluate('=IFERROR(IFS(F1>0,1,TRUE,2),"none")')).toBe('none');
        expect(evaluate('=IFS(TRUE,1,F1>0,2)')).toBe(1);
        expect(evaluate('=IFS(FALSE,1,TRUE,F1)')).toBe('#N/A');
        expect(evaluate('=SWITCH(F1,1,"a","b")')).toBe('#N/A');
        expect(evaluate('=SWITCH(1,F1,"a",1,"b")')).toBe('#N/A');
        expect(evaluate('=SWITCH(1,1,"a",F1,"b")')).toBe('a');
        expect(evaluate('=SWITCH(2,1,"a",B1)')).toBe('#DIV/0!');
    });

    test('AGGREGATE ignores errors under options 2, 3, 6 and 7, and hands them on under the others', () => {
        expect(evaluate('=AGGREGATE(9,6,A2:A4)')).toBe(4);
        expect(evaluate('=AGGREGATE(4,7,A2:A4)')).toBe(3);
        expect(evaluate('=AGGREGATE(14,6,A2:A4,2)')).toBe(1);
        expect(evaluate('=AGGREGATE(9,4,A2:A4)')).toBe('#DIV/0!');
        expect(evaluate('=AGGREGATE(9,6,F1)')).toBe(0);
    });

    test('AGGREGATE reads every reference it is given, an error in any of them included', () => {
        expect(evaluate('=AGGREGATE(4,6,A7:F7,A2:A4)')).toBe(32);
        expect(evaluate('=AGGREGATE(9,6,A2:A4,A7:F7)')).toBe(67);
        expect(evaluate('=AGGREGATE(2,6,A2:A4,A7:F7,C2:C4)')).toBe(10);
        expect(evaluate('=AGGREGATE(9,4,A7:F7,A2:A4)')).toBe('#DIV/0!');
        expect(evaluate('=AGGREGATE(14,6,A2:A4,F1)')).toBe('#N/A');
    });

    test('#SPILL!, #ERROR! and #CALC! a cell holds are errors that IFERROR and ISERROR see', () => {
        expect(['A6', 'B6', 'C6'].map((c) => evaluate(`=ISERROR(${c})`))).toEqual([true, true, true]);
        expect(['A6', 'B6', 'C6'].map((c) => evaluate(`=ISERR(${c})`))).toEqual([true, true, true]);
        expect(['A6', 'B6', 'C6'].map((c) => evaluate(`=IFERROR(${c},"none")`))).toEqual(['none', 'none', 'none']);
        expect(['A6', 'B6', 'C6'].map((c) => evaluate(`=ERROR.TYPE(${c})`))).toEqual([9, 8, 14]);
        expect(['A6', 'B6', 'C6'].map((c) => evaluate(`=${c}+1`))).toEqual(['#SPILL!', '#ERROR!', '#CALC!']);
        expect(evaluate('=ISNA(A6)')).toBe(false);
        expect(evaluate('=IFNA(A6,"none")')).toBe('#SPILL!');
    });

    test('a rich-text cell whose runs read #N/A stays text', () => {
        expect(evaluate('=ISERROR(D6)')).toBe(false);
        expect(evaluate('=ISTEXT(D6)')).toBe(true);
        expect(evaluate('=D6')).toBe('#N/A');
    });
});
