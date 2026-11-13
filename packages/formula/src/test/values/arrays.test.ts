import { describe, expect, test } from 'bun:test';
import { DIV0, NA, REF, VALUE } from '../../index';
import type { Cells } from '../recalc/support';
import { engineOf, evaluate, valueAt } from '../recalc/support';

// A cell shows the top-left of an array, so each element is read with INDEX and the size with a sum of ones.
function element(formula: string, row: number, column: number, cells: Cells = {}, host = 'N1') {
    return evaluate(`=INDEX(${formula.slice(1)},${row},${column})`, cells, host);
}

function elements(formula: string, rows: number, columns: number, cells: Cells = {}) {
    return Array.from({ length: rows }, (_, r) =>
        Array.from({ length: columns }, (_, c) => element(formula, r + 1, c + 1, cells)),
    );
}

const FIXTURE: Cells = { F5: 2, F6: 4, F7: 7, F8: 7, G5: 4, G6: 2, G7: 6, G8: 4 };

describe('element by element', () => {
    test.each([
        ['=F5:F8*2', [[4], [8], [14], [14]]],
        ['=F5:F8+G5:G8', [[6], [6], [13], [11]]],
        ['=F5:F8*{1;2;3}', [[2], [8], [21], [NA]]],
        ['=F5:F8={2;4;7;8}', [[true], [true], [true], [false]]],
        ['=F5:F8&{"x";3;TRUE;8.4}&"!"', [['2x!'], ['43!'], ['7TRUE!'], ['78.4!']]],
        [
            '=F5:F8+{1,2}',
            [
                [3, 4],
                [5, 6],
                [8, 9],
                [8, 9],
            ],
        ],
    ])('%s', (formula, expected) => {
        expect(elements(formula, expected.length, expected[0].length, FIXTURE)).toEqual(expected);
    });

    test.each([
        [
            '={1,2,3}+{10;20}',
            [
                [11, 12, 13],
                [21, 22, 23],
            ],
        ],
        ['={1,2}+{1,2,3}', [[2, 4, NA]]],
        [
            '={1,2;3,4}+{10,20,30}',
            [
                [11, 22, NA],
                [13, 24, NA],
            ],
        ],
        [
            '={1,2;3,4}*{1,2;3,4}',
            [
                [1, 4],
                [9, 16],
            ],
        ],
        [
            '={1,2,3}+{1,2;3,4}',
            [
                [2, 4, NA],
                [4, 6, NA],
            ],
        ],
        ['=-{1,2}', [[-1, -2]]],
        ['={50,25}%', [[0.5, 0.25]]],
        ['={1,"a",TRUE,#N/A}+1', [[2, VALUE, 2, NA]]],
        ['={1,2}+#N/A', [[NA, NA]]],
        ['=#DIV/0!+{1,#N/A}', [[DIV0, DIV0]]],
        ['={1,#N/A}=1', [[true, NA]]],
        [
            '={-1,2;-3,4}',
            [
                [-1, 2],
                [-3, 4],
            ],
        ],
        ['=49/{49}', [[1]]],
    ])('%s', (formula, expected) => {
        expect(elements(formula, expected.length, expected[0].length)).toEqual(expected);
    });

    test('a result past the size of the array is #REF!, so the sizes above are the whole array', () => {
        expect(element('={1,2}+{1,2,3}', 1, 4)).toMatchObject({ text: '#REF!' });
        expect(element('={1,2}+{1,2,3}', 2, 1)).toMatchObject({ text: '#REF!' });
        expect(element('=F5:F8*2', 5, 1, FIXTURE)).toMatchObject({ text: '#REF!' });
    });

    test('a cell shows the top-left value of an array', () => {
        expect(evaluate('=F5:F8*2', FIXTURE)).toBe(4);
        expect(evaluate('={1,2;3,4}')).toBe(1);
        expect(evaluate('=F5:F8', FIXTURE)).toBe(2);
        expect(evaluate('=F5:F5', FIXTURE)).toBe(2);
    });

    test('an aggregate takes the whole array', () => {
        expect(evaluate('=SUM(F5:F8+G5:G8)', FIXTURE)).toBe(36);
        expect(evaluate('=SUM({1,2;3,4})', FIXTURE)).toBe(10);
        expect(evaluate('=SUM({1,2}+{1;2})', FIXTURE)).toBe(12);
        expect(evaluate('=SUM(--({1,2,3}>1))', FIXTURE)).toBe(2);
        expect(evaluate('=SUM(F5:F8*{1;2;3})', FIXTURE)).toBe(NA);
        expect(evaluate('=AND({TRUE,FALSE})')).toBe(false);
    });
});

// Excel's answers, second batch, for the first four: a whole column is 1,048,576 rows whatever the sheet holds.
describe('an array has the size that was written', () => {
    const cells: Cells = { A1: 'x', A2: 'y', A3: 'x', B1: 10, B2: 20, B3: 30, C1: 2, D1: 3 };

    test.each([
        ['=SUMPRODUCT(B:B,--(A:A="x"))', 40],
        ['=SUM(B:B*Sheet2!D:D)', 9000],
        ['=SUM(--(B:B=""))', 1048573],
        ['=SUMPRODUCT(--(A:A=""))', 1048573],
        ['=SUMPRODUCT((A:A="x")*B:B)', 40],
        ['=SUMPRODUCT(B:B,B:B)', 1400],
        ['=SUMPRODUCT(B:B+1,B:B+1)', 121 + 441 + 961 + 1048573],
        ['=SUMPRODUCT(A:B="x",A:B="x")', 0],
        ['=SUMPRODUCT(--(A:B="x"),--(A:B<>"y"))', 2],
        ['=SUMPRODUCT(--(A:B=""),--(A:B=""))', 2 * 1048573],
        ['=SUMPRODUCT(B:B,A1:A1048575)', VALUE],
        ['=COUNT(--(A:A="x"))', 1048576],
        ['=COUNTA(B:B&"")', 1048576],
        ['=AVERAGE(B:B*1)', 60 / 1048576],
        ['=MAX(--(B:B=""))', 1],
        ['=MIN(B:B+5)', 5],
        ['=AND(B:B<100)', true],
        ['=OR(B:B>100)', false],
        ['=SUM(B:B+{1,2})', 2 * 60 + 3 * 1048576],
        ['=SUM({1;2}+B2:XFD2)', 3 * 16383 + 2 * 20],
        ['=SUM((A:B="x")*1)', 2],
        ['=SUM((A:C="")*1)', 3 * 1048576 - 7],
        ['=SUM((2:2="y")*1)', 1],
        ['=SUM((2:2="")*1)', 16384 - 2],
        ['=SUM(B1:M1048576*1)', 65],
        ['=SUM(B1:B1000000*C1:F1)', 300],
        ['=INDEX(--(B:B=""),3)', 0],
        ['=INDEX(--(B:B=""),4)', 1],
        ['=INDEX(--(B:B=""),1048576)', 1],
        ['=INDEX(--(B:B=""),1048577)', REF],
        ['=INDEX(B:B*2,2)', 40],
        ['=INDEX(B:C*2,1,2)', 4],
        ['=INDEX(B:C*2,900,2)', 0],
        ['=SUM(INDEX((A:C="")*1,0,3))', 1048575],
        ['=SUM(INDEX((A:C="")*1,0,2))', 1048573],
        ['=SUM(INDEX((A:C="")*1,500000,0))', 3],
        ['=SUM(INDEX((A:C="")*1,2,0))', 1],
        ['=SUM(ROW(B:B))', 549756338176],
        ['=SUM(COLUMN(1:1))', (16384 * 16385) / 2],
        ['=MATCH(1,--(A:A="y"),0)', 2],
        ['=MATCH(1,--(A:A=""),0)', 4],
        ['=XMATCH(0,--(A:A="x"),0,-1)', 1048576],
        ['=XMATCH(1,--(A:A="x"),0,-1)', 3],
        ['=VLOOKUP(40,B:B*2,1,FALSE)', 40],
        ['=XLOOKUP(1,--(A:A="y"),B:B*3)', 60],
        ['=A1:XFC1048575', REF],
        ['=Sheet2!A1:XFC1048575', 0],
        ['=Sheet2!D3:XFC1048575', 300],
        ['=A:A="x"', true],
        ['=@(B:B+1)', 11],
    ])('%s is %p', (formula, expected) => {
        expect(evaluate(formula, cells)).toBe(expected);
    });

    test('a value does not depend on a cell the formula does not name', () => {
        const engine = engineOf({ s1: { ...cells, N1: '=SUM(--(B:B=""))', N2: '=SUM((3:3="")*1)' } });
        engine.recalc(Number.POSITIVE_INFINITY);
        expect(valueAt(engine, 'N1')).toBe(1048573);
        expect(valueAt(engine, 'N2')).toBe(16382);
        engine.setValue('s1', 99, 25, 1);
        engine.setFormula('s1', 5, 13, '=R1C14+R2C14');
        engine.recalc(Number.POSITIVE_INFINITY);
        expect(valueAt(engine, 'N6')).toBe(1048573 + 16382);
        expect(valueAt(engine, 'N1')).toBe(1048573);
        expect(valueAt(engine, 'N2')).toBe(16382);
    });

    test('a range stores the cells it holds, so a pass with a small cap still computes it', () => {
        const sheets = {
            s1: { ...cells, N1: '=SUM(B1:B1000000*C1:F1)', N2: '=SUM(--(Sheet2!A:XFD=""))' },
            s2: { D3: 300 },
        };
        const engine = engineOf(sheets);
        expect(engine.recalc(1000).stopped).toBe(false);
        expect(valueAt(engine, 'N1')).toBe(300);
        expect(valueAt(engine, 'N2')).toBe(16384 * 1048576 - 1);
    });

    test('the elements an operator makes count against the cap of a pass', () => {
        const filled: Record<string, number | string> = { N1: '=SUM(A1:A2000*2)', N2: '=N1+1' };
        for (let row = 1; row <= 2000; row += 1) filled[`A${row}`] = row;
        expect(engineOf({ s1: filled }).recalc(1000).stopped).toBe(true);
        expect(engineOf({ s1: filled }).recalc(100000).stopped).toBe(false);
    });

    test('a shorter array is #N/A past its own last row, whatever the sheet holds', () => {
        expect(evaluate('=INDEX(B1:B3*{1;2},3)', cells)).toBe(NA);
        expect(evaluate('=INDEX(B1:B5*{1;2;3},3)', cells)).toBe(90);
        expect(evaluate('=INDEX(B1:B5*{1;2;3},4)', cells)).toBe(NA);
        expect(evaluate('=INDEX(B1:B10*C1:C20,1)', cells)).toBe(20);
        expect(evaluate('=INDEX(B1:B10*C1:C20,8)', cells)).toBe(0);
        expect(evaluate('=INDEX(B1:B10*C1:C20,10)', cells)).toBe(0);
        expect(evaluate('=INDEX(B1:B10*C1:C20,11)', cells)).toBe(NA);
        expect(evaluate('=INDEX(B1:B10*C1:C20,20)', cells)).toBe(NA);
        expect(evaluate('=SUM(B1:B10*C1:C20)', cells)).toBe(NA);
        expect(evaluate('=INDEX(B1:C2+B1:F1,1,3)', cells)).toBe(NA);
        expect(evaluate('=INDEX(B1:B1000000+B:B,999999)', cells)).toBe(0);
        expect(evaluate('=INDEX(B1:B1000000+B:B,1000001)', cells)).toBe(NA);
    });
});

describe('lifting', () => {
    test.each([
        [
            '=ABS({-1,2;-3,4})',
            [
                [1, 2],
                [3, 4],
            ],
        ],
        ['=IF({TRUE,FALSE},1,2)', [[1, 2]]],
        ['=IF({TRUE,FALSE},{1,2},{3,4})', [[1, 4]]],
        ['=IF({TRUE,FALSE},1/0,2)', [[DIV0, 2]]],
        [
            '=IF({TRUE;FALSE},{1,2},9)',
            [
                [1, 2],
                [9, 9],
            ],
        ],
        ['=IF({1,0})', [[VALUE]]],
        ['=IF({1,0},"y")', [['y', false]]],
        ['=CONCATENATE("a",{1,2})', [['a1', 'a2']]],
        ['=IFERROR({1,#N/A,3},0)', [[1, 0, 3]]],
        ['=ISNUMBER({1,"a",#N/A})', [[true, false, false]]],
        ['=ABS({-1,"a",#N/A,""})', [[1, VALUE, NA, 0]]],
        [
            '=ABS({-1,-2})+{1;2}',
            [
                [2, 3],
                [3, 4],
            ],
        ],
        ['=INDEX({1,2;3,4},{2,1},1)', [[3, 1]]],
    ])('%s', (formula, expected) => {
        expect(elements(formula, expected.length, expected[0].length)).toEqual(expected);
    });

    test('a range at a scalar parameter is lifted like an array', () => {
        expect(elements('=ABS(A1:A3)', 3, 1, { A1: -1, A2: 'x', A3: -3 })).toEqual([[1], [VALUE], [3]]);
        expect(evaluate('=SUM(IFERROR(A1:A3,0))', { A1: NA, A2: DIV0, A3: 1 })).toBe(1);
        expect(evaluate('=SUM(IF(A1:A3>1,A1:A3,0))', { A1: 1, A2: 2, A3: 3 })).toBe(5);
    });

    // Excel batch 5 records ROW of an array of ranges as the first row of each.
    test('an element that would be an array is its first value', () => {
        expect(elements('=INDEX({1,2;3,4},{1,2},0)', 1, 2)).toEqual([[1, 3]]);
    });
});

describe('@', () => {
    const cells: Cells = { G7: 4, G8: 7, G9: 8, A3: 30, B3: 31, C3: 32 };

    test.each([
        ['F7', 4],
        ['F8', 7],
        ['F9', 8],
        ['F6', VALUE],
        ['F10', VALUE],
        ['G6', VALUE],
        ['G10', VALUE],
    ])('a column gives the cell in the row of the formula: at %s', (host, expected) => {
        expect(evaluate('=@$G$7:$G$9', cells, host)).toBe(expected);
    });

    test.each([
        ['=@A3:C3', 'B9', 31],
        ['=@A3:C3', 'D9', VALUE],
        ['=@G7', 'N1', 4],
        ['=@A3:C9', 'B5', VALUE],
        ['=@($G$7:$G$9)+@($G$7:$G$9)', 'I7', 8],
        ['=@($G$7:$G$9)+@($G$7:$G$9)', 'I10', VALUE],
        ['=@(G7:G9+0)', 'A28', 4],
        ['=@(G7:G9*1)', 'A29', 4],
        ['=@{5,6;7,8}', 'N1', 5],
        ['=@IF(G7>5,G7:G9*3,G7:G9*2)', 'A32', 8],
        ['=@IF(TRUE,$G$7:$G$9)', 'J8', 7],
        ['=@IF(TRUE,$G$7:$G$9)', 'J10', VALUE],
        ['=SUM(@$G$7:$G$9)', 'J9', 8],
        ['=SUM(ROW(@G7:G9))', 'J8', 8],
        ['=@5', 'N1', 5],
        ['=@Sheet2!D1:D5', 'C3', 300],
    ])('%s at %s', (formula, host, expected) => {
        expect(evaluate(formula, cells, host)).toBe(expected);
    });
});
