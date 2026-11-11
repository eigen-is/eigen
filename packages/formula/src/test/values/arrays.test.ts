import { describe, expect, test } from 'bun:test';
import { DIV0, NA, VALUE } from '../../index';
import type { Cells } from '../recalc/support';
import { evaluate } from '../recalc/support';

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

    test('a whole column in an array formula is as long as the sheet is used', () => {
        const cells: Cells = { A1: 1, A2: 2, A3: 3, B1: 10, B2: 20, B5: 50 };
        expect(evaluate('=SUM(A:A*B:B)', cells)).toBe(50);
        expect(evaluate('=SUM(--(A:A=""))', cells)).toBe(2);
        expect(evaluate('=SUM((3:3="")*1)', { A3: 1, C3: 'x' })).toBe(12);
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

    test('an element that would be an array is #CALC!', () => {
        expect(elements('=INDEX({1,2;3,4},{1,2},0)', 1, 2)).toMatchObject([[{ text: '#CALC!' }, { text: '#CALC!' }]]);
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
