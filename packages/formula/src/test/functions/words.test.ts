import { describe, expect, test } from 'bun:test';
import { cells, fn, NUMBER, NUMBERS, NUMBERS_A, optional, rest } from '../../functions/registry';
import { DIV0, NA, NUM, REF, VALUE } from '../../index';
import { dateSerial } from '../../values/dates';
import type { Cells } from '../recalc/support';
import { evaluate, evaluateWith } from '../recalc/support';

// The fixture of Excel batches 3 to 5: A1:A10 = 10..100, B1:B3 = 40, 50, 60, C1:C3 = 0.1, 0.2, -0.3 with C4
// blank, D1 = TRUE, D2 = the text TRUE, D3 blank, E1:E3 = 1, #DIV/0!, 3.
const F1: Cells = {
    ...Object.fromEntries(Array.from({ length: 10 }, (_, at) => [`A${at + 1}`, (at + 1) * 10])),
    ...{ B1: 40, B2: 50, B3: 60, C1: 0.1, C2: 0.2, C3: -0.3 },
    ...{ D1: true, D2: 'TRUE', E1: 1, E2: '=1/0', E3: 3 },
};
// Sheet b3_f of batch 3: A1:A7 = 3, 1, 4, 1, 5, 9, 2, B1:B7 = 2, 7, 1, 8, 2, 8, 1, C1:C3 = 6, 5, 3, D1:F1 = 1, 5,
// 9, H and I with errors, J and K with a text each, M1:M2 = - and +.
const F3: Cells = {
    ...{ A1: 3, A2: 1, A3: 4, A4: 1, A5: 5, A6: 9, A7: 2 },
    ...{ B1: 2, B2: 7, B3: 1, B4: 8, B5: 2, B6: 8, B7: 1, C1: 6, C2: 5, C3: 3, D1: 1, E1: 5, F1: 9 },
    ...{ H1: 1, H2: '=1/0', H3: 3, H4: 4, H5: 5, H6: 6, I1: '=NA()', I2: 2, I3: '=NA()', I4: 4, I5: 5, I6: 6 },
    ...{ J1: 1, J2: 'x', J3: 3, J4: 4, J5: 5, J6: 6, K1: 1, K2: 2, K3: 'y', K4: 4, K5: 5, K6: 7, M1: '-', M2: '+' },
};

function across(formula: string, count: number, cells: Cells, evaluated: (formula: string, cells: Cells) => unknown) {
    return Array.from({ length: count }, (_, at) => evaluated(`=INDEX(${formula.slice(1)},1,${at + 1})`, cells));
}

describe('the list of every number: MEDIAN', () => {
    test.each([
        // Excel batch 3: a union gives every area, an empty argument is a 0 and a typed boolean is 1 or 0.
        ['=MEDIAN((A1:A3,B1:B3))', 35],
        ['=MEDIAN(1,,5)', 1],
        ['=MEDIAN(TRUE,2,4)', 2],
        ['=MEDIAN(A1:A10)', 55],
        ['=MEDIAN(A1:A3)', 20],
        ['=MEDIAN(30,10,20,40)', 25],
        // What the family of SUM does with each kind of value, which batches 3 to 5 record for SUM.
        ['=MEDIAN(E1:E3)', DIV0],
        ['=MEDIAN("x",1)', VALUE],
        ['=MEDIAN(D1:D2,7)', 7],
        ['=MEDIAN(IF({1;1;1;1},C1:C4))', 0.05],
        // A stored row of an array that stands for many written ones is in the list that many times.
        ['=MEDIAN(A1:A20*1)', 5],
        ['=MEDIAN(A1:A30*1+5)', 5],
        ['=MEDIAN(A1:M1*1+5)', 5],
        ['=MEDIAN(A3:M30*1+5)', 5],
        ['=MEDIAN(A:A*1)', 0],
        ['=MEDIAN(A1:B4*1)', 35],
        ['=MEDIAN(A:A)', 55],
    ])('%s', (formula, expected) => {
        expect(evaluate(formula, F1)).toBe(expected);
    });
});

describe('numbers to multiply: PRODUCT', () => {
    test.each([
        // Excel batch 3 and 4: an empty argument and a blank value are passed over, where SUM adds a 0.
        ['=PRODUCT(2,)', 2],
        ['=PRODUCT(,2)', 2],
        ['=PRODUCT(2,IF(TRUE,))', 2],
        ['=PRODUCT(2,D3)', 2],
        ['=PRODUCT("2",3)', 6],
        ['=PRODUCT(A1:A3)', 6000],
        ['=PRODUCT(A1:A3,B1:B2)', 12000000],
        ['=PRODUCT(A1:A2*1,0.5)', 100],
        ['=SUBTOTAL(6,A1:A3)', 6000],
    ])('%s', (formula, expected) => {
        expect(evaluate(formula, F1)).toBe(expected);
    });
});

describe('the first cell of a reference: N', () => {
    test.each([
        // Excel batch 3: a range gives one value, that of its first cell.
        ['=N(A1:A3)', 3, F3],
        ['=N(J1:J3)', 1, F3],
        ['=N(J2:J4)', 0, F3],
        ['=N(TRUE)', 1, F3],
        ['=N(A1:A3)', 10, F1],
        ['=N(D1:D2)', 1, F1],
        ['=N(Z9)', 0, F1],
        // Batch 5: an array is one call per element.
        ['=SUM(N(IF(1,{1,2,3})))', 6, F1],
        ['=SUM(N({1,2,3}))', 6, F1],
        ['=SUM(N(OFFSET(A1,{0,1,2},0,2)))', 60, F1],
        ['=N()', VALUE, F1],
    ])('%s', (formula, expected, cells) => {
        expect(evaluate(formula, cells)).toBe(expected);
    });

    test.each([
        ['=N({1,2,3})', [1, 2, 3]],
        ['=N(OFFSET(A1,{0,1,2},0,2))', [10, 20, 30]],
        ['=N({5,"a",TRUE})', [5, 0, 1]],
    ])('%s', (formula, expected) => {
        expect(across(formula, 3, F1, evaluate)).toEqual(expected);
    });

    test('the formula in the first cell is computed, and no other cell of the range is read', () => {
        expect(evaluate('=N(P1:P3)', { P1: '=1+1', P2: '=1/0' }, 'A1')).toBe(2);
    });
});

describe('every value as a text: TEXTJOIN and CONCAT', () => {
    const LONG = 'x'.repeat(20000);

    test.each([
        // Excel batch 3: empty text is left out or kept, and a range of delimiters is used in turn.
        ['=TEXTJOIN(",",TRUE,IF(A1:A5>2,A1:A5,""))', '3,4,5', F3],
        ['=TEXTJOIN(",",FALSE,IF(A1:A5>2,A1:A5,""))', '3,,4,,5', F3],
        ['=TEXTJOIN(M1:M2,TRUE,B1:B5)', '2-7+1-8+2', F3],
        ['=TEXTJOIN(M1,TRUE,B1:B5)', '2-7-1-8-2', F3],
        ['=TEXTJOIN({"-","+"},TRUE,B1:B5)', '2-7+1-8+2', F3],
        // Batch 5: an array of references is #VALUE!, where SUM reads the first cell of each.
        ['=TEXTJOIN(",",TRUE,OFFSET(A1,{0,1,2},0,2))', VALUE, F1],
        ['=CONCAT(OFFSET(B1,{0,1},0,2))', VALUE, F1],
        // The values of every argument in written order, a range row by row, each spelled as & spells it.
        ['=CONCAT("a",1,TRUE)', 'a1TRUE', F1],
        ['=CONCAT(A1:B2)', '10402050', F1],
        ['=CONCAT(A1:A2,"-",{1,2;3,4})', '1020-1234', F1],
        ['=TEXTJOIN("-",TRUE,A1:A2,"x",B1:B2)', '10-20-x-40-50', F1],
        ['=TEXTJOIN(",",TRUE,A1:A3*1)', '10,20,30', F1],
        // The order a call is worked in: a typed error before the first error in a range, the ranges in turn.
        ['=CONCAT(E1:E3)', DIV0, F1],
        ['=CONCAT(E1:E3,NA())', NA, F1],
        ['=TEXTJOIN(E1:E3,NA(),"a")', NA, F1],
        ['=TEXTJOIN(E1:E3,"x","a")', VALUE, F1],
        ['=TEXTJOIN(",",TRUE,H1:H3,I1:I3)', DIV0, F3],
        ['=TEXTJOIN(",",TRUE,I1:I3,H1:H3)', NA, F3],
        ['=TEXTJOIN(I1:I3,TRUE,H1:H3)', NA, F3],
        ['=TEXTJOIN(",",TRUE)', VALUE, F1],
        // A text of more than 32,767 characters is #VALUE!.
        ['=LEN(CONCAT(P1))', 20000, { P1: LONG }],
        ['=CONCAT(P1,P1)', VALUE, { P1: LONG }],
        ['=TEXTJOIN("",TRUE,P1,P1)', VALUE, { P1: LONG }],
        ['=LEN(TEXTJOIN(",",TRUE,P1,P2,"a"))', 20002, { P1: LONG }],
    ])('%s', (formula, expected, cells) => {
        expect(evaluate(formula, cells)).toBe(expected);
    });

    test('a lookup value that is an array runs the call per element, a range of texts never does', () => {
        expect(across('=TEXTJOIN(",",{TRUE,FALSE},IF(A1:A5>2,A1:A5,""))', 2, F3, evaluate)).toEqual([
            '3,4,5',
            '3,,4,,5',
        ]);
        expect(evaluate('=INDEX(CONCAT(A1:A3),1,2)', F1)).toBe(REF);
    });

    test('the formulas of a range are computed before they are spelled', () => {
        expect(evaluate('=CONCAT(P1:P3)', { P1: '=1+1', P2: '=P1&"a"', P3: '=P2&P1' }, 'A1')).toBe('22a2a2');
    });
});

describe('two ranges side by side: CORREL', () => {
    test.each([
        // Excel batch 3: the pairs are made by place, row by row, whatever the shapes.
        ['=CORREL(A1:A6,B1:C3)', -4.23361858081695e-1],
        ['=CORREL(A1:A6,B1:B6)', -6.6924450472418e-3],
        ['=CORREL(A1:F1,A2:A7)', -2.28163329383594e-1],
        ['=CORREL(A1:F1,B1:B6)', -1.08916646841617e-1],
        // A text on either side leaves its pair out.
        ['=CORREL(A1:A6,J1:J6)', 6.30899673509503e-1],
        ['=CORREL(J1:J6,K1:K6)', 9.87541439757388e-1],
        ['=CORREL(A1:A6,{2;7;1;8;2;8})', -6.6924450472418e-3],
        ['=CORREL(A:A,B:B)', 9.611417370832981e-2],
    ])('%s', (formula, expected) => {
        expect(evaluate(formula, F3)).toBeCloseTo(expected, 13);
    });

    test.each([
        // Batch 3 and 4: unequal sizes are #N/A, an empty argument is #VALUE!, and of the errors in the two
        // ranges the one at the earliest place is the result, whichever range holds it.
        ['=CORREL(A1:A3,B1:B4)', NA],
        ['=CORREL(A1:A3,"x")', NA],
        ['=CORREL(A1:A3,)', VALUE],
        ['=CORREL(H1:H6,I1:I6)', NA],
        ['=CORREL(I1:I6,H1:H6)', NA],
        ['=CORREL(A1:A6,H1:H6)', DIV0],
        ['=CORREL(A1:A6,I1:I6)', NA],
        ['=CORREL(H2:H6,I2:I6)', DIV0],
        ['=CORREL(1/0,I1:I6)', DIV0],
        ['=CORREL(A1:A6)', VALUE],
    ])('%s', (formula, expected) => {
        expect(evaluate(formula, F3)).toBe(expected);
    });

    test('an error beside the blank cells under a shorter column is still the result', () => {
        const cells = { P1: 1, P2: 2, P3: 4, Q1: 3, Q2: 5, Q3: 6, Q5: '=1/0' };
        expect(evaluate('=CORREL(P1:P6,Q1:Q6)', cells)).toBe(DIV0);
        expect(evaluate('=CORREL(Q1:Q6,P1:P6)', cells)).toBe(DIV0);
        expect(evaluate('=CORREL(P1:P4,Q1:Q4)', cells)).toBeCloseTo(0.9285714285714286, 13);
    });

    test('the formulas of both ranges are computed before they are paired', () => {
        const cells = { P1: '=1+1', P2: '=P1*2', P3: '=P2*3', Q1: 1, Q2: '=Q1+1', Q3: '=Q2+2' };
        expect(evaluate('=CORREL(P1:P3,Q1:Q3)', cells, 'A1')).toBeCloseTo(0.989743318610787, 13);
    });
});

// LARGE is not a function of this build: the row is the test's own, on the list and a number after it.
describe('a parameter that takes every value before one that takes a single value', () => {
    // A k below 1 is refused before it is rounded up.
    const LARGE = fn('LARGE', [NUMBERS, NUMBER], (numbers, k) => {
        const sorted = numbers.list().sort();
        return k < 1 || k > sorted.length ? NUM : sorted[sorted.length - Math.ceil(k)];
    });
    const large = (formula: string, cells: Cells) => evaluateWith([LARGE], formula, cells);

    test.each([
        // Batch 3, 4 and 5: the count is read before the range is looked into, whose error then comes before
        // the body's own.
        ['=LARGE(A1:A5,1.9)', 4, F3],
        ['=LARGE(A1,1)', 3, F3],
        ['=LARGE(A1,2)', NUM, F3],
        ['=LARGE(H1:H3,"x")', VALUE, F3],
        ['=LARGE(H1:H3,1)', DIV0, F3],
        ['=LARGE(E1:E3,0)', DIV0, F1],
        ['=LARGE(E1:E3,5)', DIV0, F1],
        ['=LARGE(A1:A3,0)', NUM, F1],
        ['=LARGE(A1:A5,0.5)', NUM, F1],
        ['=LARGE(1/0,"x")', DIV0, F1],
        ['=LARGE((A1:A3,B1:B3),1)', 60, F1],
        ['=LARGE({1,2,3},)', NUM, F1],
    ])('%s', (formula, expected, cells) => {
        expect(large(formula, cells)).toBe(expected);
    });

    // RANK is not a function of this build either: its numbers are a range and nothing else, between two values.
    test('a parameter that takes every value of a reference only, between two that take a single value', () => {
        const RANK = fn('RANK', [NUMBER, cells(NUMBERS), optional(NUMBER, 0)], (number, numbers, order) => {
            const list = numbers.list();
            const ahead = list.filter((other) => (order === 0 ? other > number : other < number)).length;
            return list.includes(number) ? ahead + 1 : NA;
        });
        const rank = (formula: string) => evaluateWith([RANK], formula, F1);
        // Excel batch 3 and 5.
        expect(rank('=RANK(20,(A1:A3,B1:B3))')).toBe(5);
        expect(rank('=RANK(20,A1:A3,)')).toBe(2);
        expect(rank('=RANK(20,A1:A3,1)')).toBe(2);
        expect(rank('=RANK(20,{10,20})')).toBe(VALUE);
        expect(across('=RANK(20,OFFSET(A1,{0,1},0,3))', 2, F1, rank)).toEqual([2, 3]);
    });

    test.each([
        ['=LARGE(A1:A5,{1,2,"x"})', [5, 4, VALUE]],
        ['=LARGE(A1:A5,{1,2,3})', [5, 4, 3]],
        ['=LARGE(A1:A5,{1,2,9})', [5, 4, NUM]],
    ])('%s', (formula, expected) => {
        expect(across(formula, 3, F3, large)).toEqual(expected);
    });
});

// AVERAGEA and MAXA are not functions of this build: the rows are the test's own.
describe('the numbers, with a boolean in a cell as 1 or 0 and a text in a cell as 0', () => {
    const ROWS = [
        fn('MAXA', [rest(NUMBERS_A)], (numbers) => (numbers.count() === 0 ? 0 : numbers.max())),
        fn('AVERAGEA', [rest(NUMBERS_A)], (numbers) => numbers.sum() / numbers.count()),
    ];

    test.each([
        // Excel batch 4.
        ['=MAXA(D1:D2)', 1],
        ['=AVERAGEA("x",1)', VALUE],
        ['=AVERAGEA(D1:D2)', 0.5],
        ['=AVERAGEA(D1:D3,A1)', 11 / 3],
        ['=MAXA(D2:D3)', 0],
        ['=MAXA(D2:E2)', DIV0],
        ['=AVERAGEA(D1:E1,D2:E2)', DIV0],
    ])('%s', (formula, expected) => {
        expect(evaluateWith(ROWS, formula, F1)).toBe(expected);
    });
});

// DATE is not a function of this build, and it needs no word of its own: Excel cuts its parts down, which a
// body does to a NUMBER.
test('a whole number that is cut down is a NUMBER and the body', () => {
    const DATE = fn('DATE', [NUMBER, NUMBER, NUMBER], (year, month, day) =>
        dateSerial(Math.floor(year), Math.floor(month), Math.floor(day)),
    );
    // Excel batch 4 and 5: 1 January 2020, and 1 November 2019 for a month of -0.5.
    expect(evaluateWith([DATE], '=DATE(2020,1.9,1.9)')).toBe(43831);
    expect(evaluateWith([DATE], '=DATE(2020,-0.5,1)')).toBe(43770);
});
