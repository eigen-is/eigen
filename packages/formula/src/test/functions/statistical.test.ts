import { describe, expect, test } from 'bun:test';
import { DIV0, NA, NUM, VALUE } from '../../index';
import type { Cells } from '../recalc/support';
import { evaluate } from '../recalc/support';

// A1 = text 1, A2 = TRUE, A3 = 2, A4 empty, A5 = text abc, A6 = #N/A, A7 = text TRUE, A8 = empty text.
const MIXED: Cells = { A1: '1', A2: true, A3: 2, A5: 'abc', A6: NA, A7: 'TRUE', A8: '=""' };

describe('COUNT, COUNTA and COUNTBLANK', () => {
    test.each([
        ['=COUNT("1",1,TRUE,"a")', 3],
        ['=COUNT(A1:A8)', 1],
        ['=COUNT(A6,1)', 1],
        ['=COUNT(1,"2",TRUE,"x",A1:A3)', 4],
        ['=COUNT(A:A,B:B)', 1],
        ['=COUNT({1,"2",TRUE,3})', 2],
        ['=COUNT(1,,2)', 3],
        ['=COUNT("")', 0],
        ['=COUNT(#N/A,1/0)', 0],
        ['=COUNT(A1:A3*1)', 3],
        ['=COUNT((A1:A2,A3:A6))', 1],
        ['=COUNTA(A1:A8)', 7],
        ['=COUNTA("")', 1],
        ['=COUNTA(1,)', 2],
        ['=COUNTA(A:A)', 7],
        ['=COUNTA(A4)', 0],
        ['=COUNTA(A6,#N/A,{1,2})', 4],
        ['=COUNTA(ZZ1:ZZ9)', 0],
        ['=COUNTBLANK(A1:A8)', 2],
        ['=COUNTBLANK(A1:B8)', 10],
        ['=COUNTBLANK(A:A)', 1048576 - 6],
        ['=COUNTBLANK(ZZ1:ZZ9)', 9],
        ['=COUNTBLANK(A4)', 1],
        ['=COUNTBLANK({1,2})', VALUE],
        ['=COUNTBLANK(1/0)', DIV0],
    ])('%s is %p', (formula, expected) => {
        expect(evaluate(formula, MIXED)).toBe(expected);
    });

    test('a formula that is still to be computed counts by its result', () => {
        expect(evaluate('=COUNT(A1:A3)', { A1: '=1+1', A2: '="a"', A3: '=1/0' })).toBe(1);
        expect(evaluate('=COUNTA(A1:A4)', { A1: '=1+1', A2: '="a"', A3: '=1/0' })).toBe(3);
        expect(evaluate('=COUNTBLANK(A1:A4)', { A1: '=1+1', A2: '=""', A3: '=1/0' })).toBe(2);
    });
});

// The sheet Excel's answers were recorded on. B1 and E3 are blank, B6 is an empty text, B4 and E6 are #DIV/0!.
const RECORDED: Cells = {
    ...{ A1: 1.5, A2: -2.5, A3: 0, A4: 10, A5: 1e300 },
    ...{ B2: '3', B3: true, B4: '=1/0', B5: 'abc', B6: '=""' },
    ...{ D1: 3, D2: 1, D3: 4, D4: 1, D5: 5, D6: 9, D7: 2, D8: 6 },
    ...{ E1: 3, E2: 'x', E4: true, E5: 5, E6: '=1/0', E7: 2, E8: '7' },
    ...{ F1: 'x', F2: 'y', F3: 'z' },
    ...{ H1: 2, H2: 7, H3: 1, H4: 8, H5: 2, H6: 8, H7: 1, H8: 8 },
    ...{ I1: 1, I2: 2, I3: 3, I4: 4, I5: 5, I6: 6, I7: 7, I8: 8 },
    ...{ J1: 5, J2: 5, J3: 5, J4: 5, J5: 5 },
    ...{ N1: 1, N2: 1, N3: 2, N4: 2, N5: 3, N6: 4 },
};

type Row = readonly [formula: string, expected: number | boolean | typeof NUM];

// Excel's answer in the 15 digits it shows.
function recorded(name: string, rows: readonly Row[], cells = RECORDED) {
    test.each(rows)(`${name}: %s is %p`, (formula, expected) => {
        const value = evaluate(formula, cells, 'Q1');
        const shown = typeof value === 'number' ? Number(value.toPrecision(15)) : value;
        expect(shown).toBe(typeof expected === 'number' ? Number(expected.toPrecision(15)) : expected);
    });
}

describe('LARGE and SMALL', () => {
    recorded('LARGE rounds its place up', [
        ['=LARGE(D1:D8,1)', 9],
        ['=LARGE(D1:D8,8)', 1],
        ['=LARGE(D1:D8,1.1)', 6],
        ['=LARGE(D1:D8,1.9)', 6],
        ['=LARGE(D1:D8,7.9999999999999)', 1],
        ['=LARGE(D1:D8,8.0000000000001)', NUM],
        ['=LARGE(D1:D8,0)', NUM],
        ['=LARGE(D1:D8,0.5)', NUM],
        ['=LARGE(D1:D8,-1)', NUM],
        ['=LARGE(D1:D8,9)', NUM],
        ['=LARGE(D1:D8,B1)', NUM],
        ['=LARGE(D1:D8,"3")', 5],
        ['=LARGE(E1:E5,1)', 5],
        ['=LARGE(E1:E8,1)', DIV0],
        ['=LARGE(F1:F3,1)', NUM],
        ['=LARGE(B3,1)', NUM],
        ['=LARGE(TRUE,1)', 1],
        ['=LARGE(,1)', 0],
        ['=LARGE((D1:D3,D5:D8),1)', 9],
        ['=LARGE({3,"x",TRUE,5},1)', 5],
        ['=LARGE(A1:A5,1)', 1e300],
    ]);
    recorded('SMALL cuts its place', [
        ['=SMALL(D1:D8,1)', 1],
        ['=SMALL(D1:D8,8)', 9],
        ['=SMALL(D1:D8,"3")', 2],
        ['=SMALL(D1:D8,1.9)', 1],
        ['=SMALL(D1:D8,7.9999999999999)', 6],
        ['=SMALL(D1:D8,8.0000000000001)', NUM],
        ['=SMALL(D1:D8,8.9)', NUM],
        ['=SMALL(D1:D8,0.5)', NUM],
        ['=SMALL(D1:D8,0)', NUM],
        ['=SMALL(E1:E5,1)', 3],
        ['=SMALL(Z1:Z3,1)', NUM],
        ['=SMALL(A1:A5,1)', -2.5],
        ['=SMALL(E1:E8,1)', DIV0],
    ]);
});

describe('RANK, RANK.EQ and RANK.AVG', () => {
    recorded('a number among the numbers of a reference', [
        ['=RANK(5,D1:D8)', 3],
        ['=RANK(5,D1:D8,0)', 3],
        ['=RANK(5,D1:D8,)', 3],
        ['=RANK(5,D1:D8,B1)', 3],
        ['=RANK(5,D1:D8,1)', 6],
        ['=RANK(5,D1:D8,-1)', 6],
        ['=RANK(1,D1:D8,0.5)', 1],
        ['=RANK(5,D1:D8,TRUE)', 6],
        ['=RANK(1,D1:D8)', 7],
        ['=RANK(1,D1:D8,1)', 1],
        ['=RANK(7,D1:D8)', NA],
        ['=RANK(1.5,D1:D8)', NA],
        ['=RANK(,D1:D8,0)', NA],
        ['=RANK("3",D1:D8,0)', 5],
        ['=RANK(TRUE,D1:D8,0)', 7],
        ['=RANK("abc",D1:D8,0)', VALUE],
        ['=RANK(3,E1:E5)', 2],
        ['=RANK(3,E1:E8)', DIV0],
        ['=RANK(5,B2,0)', NA],
        ['=RANK(5,F1:F3)', NA],
        ['=RANK(3,(D1:D3,D5:D8))', 5],
        ['=RANK(1E+300,A1:A5)', 1],
        ['=RANK(-2.5,A1:A5,1)', 1],
        ['=RANK.EQ(2,N1:N6)', 3],
        ['=RANK.EQ(2,N1:N6,1)', 3],
        ['=RANK.EQ(8,H1:H8,1)', 6],
        ['=RANK.EQ(7,D1:D8)', NA],
        // Excel refuses these when they are entered; here they are an error.
        ['=RANK(5,{3,1,4,1,5})', VALUE],
        ['=RANK(5,5)', VALUE],
    ]);
    recorded('RANK.AVG gives equal numbers the mean of their ranks', [
        ['=RANK.AVG(1,D1:D8)', 7.5],
        ['=RANK.AVG(1,D1:D8,1)', 1.5],
        ['=RANK.AVG(TRUE,D1:D8,0)', 7.5],
        ['=RANK.AVG(5,D1:D8)', 3],
        ['=RANK.AVG(8,H1:H8)', 2],
        ['=RANK.AVG(8,H1:H8,1)', 7],
        ['=RANK.AVG(2,N1:N6,1)', 3.5],
        ['=RANK.AVG(7,D1:D8)', NA],
        ['=RANK.AVG(3,E1:E8)', DIV0],
    ]);
});

describe('RANK ties', () => {
    test('two numbers that are equal in 15 digits share a rank, as they are equal everywhere else', () => {
        const cells = { F1: 2.6999999999999997, F2: 2.7, F3: 1 };
        expect(evaluate('=F1=F2', cells)).toBe(true);
        expect(evaluate('=RANK(F1,F1:F3)', cells)).toBe(1);
        expect(evaluate('=RANK(F2,F1:F3)', cells)).toBe(1);
        expect(evaluate('=RANK(F3,F1:F3)', cells)).toBe(3);
        expect(evaluate('=RANK(F3,F1:F3,1)', cells)).toBe(1);
        expect(evaluate('=RANK(2.7,F1:F3,1)', cells)).toBe(2);
        expect(evaluate('=RANK.AVG(F1,F1:F3)', cells)).toBe(1.5);
    });
});

describe('PERCENTILE and QUARTILE', () => {
    recorded('from the smallest at 0 to the largest at 1', [
        ['=PERCENTILE.INC(D1:D8,0)', 1],
        ['=PERCENTILE.INC(D1:D8,1)', 9],
        ['=PERCENTILE.INC(D1:D8,0.5)', 3.5],
        ['=PERCENTILE.INC(D1:D8,0.25)', 1.75],
        ['=PERCENTILE.INC(D1:D8,0.9)', 6.9],
        ['=PERCENTILE.INC(D1:D8,0.99)', 8.79],
        ['=PERCENTILE.INC(D1:D8,7/8)', 6.375],
        ['=PERCENTILE.INC(D1:D8,8/9)', 6.66666666666666],
        ['=PERCENTILE.INC(D1:D8,0.9999999999)', 8.9999999979],
        ['=PERCENTILE.INC(D1:D8,1E-300)', 1],
        ['=PERCENTILE.INC(D1:D8,1.1)', NUM],
        ['=PERCENTILE.INC(D1:D8,-0.1)', NUM],
        ['=PERCENTILE.INC(D1:D8,"0.5")', 3.5],
        ['=PERCENTILE.INC(D1:D8,B1)', 1],
        ['=PERCENTILE.INC(F1:F3,1)', NUM],
        ['=PERCENTILE.INC(B1,1)', NUM],
        ['=PERCENTILE.INC(E1:E8,1)', DIV0],
        ['=PERCENTILE.INC(,1)', 0],
        ['=PERCENTILE.INC(A1:A5,1)', 1e300],
        ['=PERCENTILE.INC({3,"x",TRUE,5},1)', 5],
        ['=PERCENTILE(D1:D8,0.25)', 1.75],
        ['=PERCENTILE(D1:D8,1.1)', NUM],
        ['=PERCENTILE(Z1:Z3,1)', NUM],
    ]);
    recorded('PERCENTILE.EXC leaves the two ends out', [
        ['=PERCENTILE.EXC(D1:D8,0.5)', 3.5],
        ['=PERCENTILE.EXC(D1:D8,0.25)', 1.25],
        ['=PERCENTILE.EXC(D1:D8,1/9)', 1],
        ['=PERCENTILE.EXC(D1:D8,8/9)', 9],
        ['=PERCENTILE.EXC(D1:D8,0.875)', 8.625],
        ['=PERCENTILE.EXC(D1:D8,0.3333333333333333)', 2],
        ['=PERCENTILE.EXC(D1:D8,0.1)', NUM],
        ['=PERCENTILE.EXC(D1:D8,0.9)', NUM],
        ['=PERCENTILE.EXC(D1:D8,0)', NUM],
        ['=PERCENTILE.EXC(D1:D8,1)', NUM],
        ['=PERCENTILE.EXC(D1:D8,-0.1)', NUM],
        ['=PERCENTILE.EXC(5,1)', NUM],
        ['=PERCENTILE.EXC(Z1:Z3,1)', NUM],
        ['=PERCENTILE.EXC(E1:E8,1)', DIV0],
    ]);
    recorded('a quarter is cut to a whole number', [
        ['=QUARTILE.INC(D1:D8,0)', 1],
        ['=QUARTILE.INC(D1:D8,1)', 1.75],
        ['=QUARTILE.INC(D1:D8,2)', 3.5],
        ['=QUARTILE.INC(D1:D8,3)', 5.25],
        ['=QUARTILE.INC(D1:D8,4)', 9],
        ['=QUARTILE.INC(D1:D8,1.5)', 1.75],
        ['=QUARTILE.INC(D1:D8,0.9)', 1],
        ['=QUARTILE.INC(D1:D8,4.1)', 9],
        ['=QUARTILE.INC(D1:D8,3.9999999)', 5.25],
        ['=QUARTILE.INC(D1:D8,5)', NUM],
        ['=QUARTILE.INC(D1:D8,-1)', NUM],
        ['=QUARTILE.INC(D1:D8,1E+300)', NUM],
        ['=QUARTILE.INC(D1:D8,TRUE)', 1.75],
        ['=QUARTILE.INC(A1:A5,1)', 0],
        ['=QUARTILE.INC({1.5,-2.5;0,10},1)', -0.625],
        ['=QUARTILE.INC(F1:F3,1)', NUM],
        ['=QUARTILE.INC(E1:E8,1)', DIV0],
        ['=QUARTILE(D1:D8,3)', 5.25],
        ['=QUARTILE(D1:D8,5)', NUM],
        ['=QUARTILE(N1:N6,1)', 1.25],
    ]);
    recorded('a quarter under 0 is refused before it is cut', [
        ['=QUARTILE(D1:D8,-0.5)', NUM],
        ['=QUARTILE.INC(D1:D8,-0.5)', NUM],
        ['=QUARTILE.EXC(D1:D8,-0.5)', NUM],
    ]);
    recorded('QUARTILE.EXC', [
        ['=QUARTILE.EXC(D1:D8,1)', 1.25],
        ['=QUARTILE.EXC(D1:D8,2)', 3.5],
        ['=QUARTILE.EXC(D1:D8,3)', 5.75],
        ['=QUARTILE.EXC(D1:D8,0)', NUM],
        ['=QUARTILE.EXC(D1:D8,4)', NUM],
    ]);
});

describe('STDEV and VAR', () => {
    recorded('of a sample', [
        ['=VAR.S(D1:D8)', 7.55357142857143],
        ['=VAR.S(D1:D8,"3")', 6.69444444444444],
        ['=VAR.S(D1:D8,)', 8.27777777777778],
        ['=VAR.S(TRUE,5)', 8],
        ['=VAR.S(5,5)', 0],
        ['=VAR.S(5)', DIV0],
        ['=VAR.S(B3,5)', DIV0],
        ['=VAR.S(F1:F3)', DIV0],
        ['=VAR.S(E1:E5)', 2],
        ['=VAR.S(E1:E8)', DIV0],
        ['=VAR.S("abc",5)', VALUE],
        ['=VAR.S((D1:D3,D5:D8),10)', 10.2857142857143],
        ['=VAR.S(IF({1;1;1},E1:E3))', 4.5],
        ['=VAR(D1:D8)', 7.55357142857143],
        ['=VAR(5)', DIV0],
        ['=STDEV.S(D1:D8)', 2.74837614393871],
        ['=STDEV.S(-5,5)', 7.07106781186548],
        ['=STDEV.S(D1)', DIV0],
        ['=STDEV.S(,)', 0],
        ['=STDEV(D1:D8,E1:E5)', 2.46981780704569],
        ['=STDEV(0)', DIV0],
    ]);
    recorded('of a whole population', [
        ['=VAR.P(D1:D8)', 6.609375],
        ['=VAR.P(5)', 0],
        ['=VAR.P(Z1:Z3)', DIV0],
        ['=VAR.P(B2)', DIV0],
        ['=VAR.P(E1:E8)', DIV0],
        ['=STDEV.P(D1:D8)', 2.57087047515039],
        ['=STDEV.P(D1)', 0],
        ['=STDEV.P(5,,6)', 2.62466929133727],
        ['=STDEV.P(F1:F3)', DIV0],
    ]);
    recorded('numbers whose squares no number holds are refused, one alone and equal ones too', [
        ['=VAR.S(A1:A5)', NUM],
        ['=VAR.S(A5)', NUM],
        ['=VAR.S(1E+154,1E+154)', NUM],
        ['=VAR.P(A5)', NUM],
        ['=VAR.P(1E+200,1E+200)', NUM],
        ['=STDEV.S(A5,A5)', NUM],
        ['=STDEV.P(1E+154,1E+154)', NUM],
        ['=STDEVA(A5)', NUM],
    ]);
    recorded('STDEVA takes a text cell as 0 and a boolean cell as 1 or 0', [
        ['=STDEVA(D1:D8)', 2.74837614393871],
        ['=STDEVA(E1:E5)', 2.21735578260835],
        ['=STDEVA(F1:F3)', 0],
        ['=STDEVA(B2,5)', 3.53553390593274],
        ['=STDEVA(B3,5)', 2.82842712474619],
        ['=STDEVA(B1,5)', DIV0],
        ['=STDEVA(F1)', DIV0],
        ['=STDEVA("abc",5)', VALUE],
        ['=STDEVA(E1:E8)', DIV0],
    ]);
    recorded('the older names', [
        ['=VARP(D1:D8)', 6.609375],
        ['=STDEVP(D1:D8)', 2.57087047515039],
        ['=VARA(E1:E5)', 4.91666666666667],
        ['=VARPA(E1:E5)', 3.6875],
        ['=STDEVPA(E1:E5)', 1.92028643696715],
        ['=VARPA(F1)', 0],
    ]);
    recorded(
        'the older names over a text, a boolean and a blank cell',
        [
            ['=VARP(A1:A5)', 400],
            ['=STDEVP(A1:A5)', 20],
            ['=VARA(A1:A5)', 556.916666666667],
            ['=VARPA(A1:A5)', 417.6875],
            ['=STDEVPA(A1:A5)', 20.4374044340273],
            ['=STDEVA(A1:A5)', 23.5990819030459],
        ],
        { A1: 10, A2: 'x', A3: true, A5: 50 },
    );
    recorded('equal decimals have the spread their sum leaves, as in Excel', [
        ['=STDEV(0.1,0.1,0.1)', 1.69967494438815e-17],
        ['=VAR(0.1,0.1,0.1)', 2.88889491658085e-34],
        ['=DEVSQ(0.1,0.1,0.1)', 5.77778983316171e-34],
        ['=AVEDEV(0.1,0.1,0.1)', 1.38777878078145e-17],
        ['=STDEV(1.1,1.1,1.1,1.1)', 0],
        ['=SLOPE({1,2,3},{0.1,0.1,0.1})', 0],
        ['=CORREL({1,2,3},{0.1,0.1,0.1})', 0],
    ]);
    recorded('a mean that is no round number keeps its digits', [
        ['=VAR(1E+12+1,1E+12+2,1E+12+3)', 1],
        ['=DEVSQ(1E+12+0.25,1E+12+0.5,1E+12+0.75)', 0.125],
    ]);
});

describe('AVERAGEA, MAXA and MINA', () => {
    recorded('a text cell is 0 and a boolean cell 1 or 0', [
        ['=AVERAGEA(D1:D8)', 3.875],
        ['=AVERAGEA(E1:E5)', 2.25],
        ['=AVERAGEA(B2,5)', 2.5],
        ['=AVERAGEA(B3,5)', 3],
        ['=AVERAGEA(B1,5)', 5],
        ['=AVERAGEA(F1:F3)', 0],
        ['=AVERAGEA(Z1:Z3)', DIV0],
        ['=AVERAGEA(E1:E8)', DIV0],
        ['=AVERAGEA("abc",5)', VALUE],
        ['=AVERAGEA(A1:A5)', 2e299],
        ['=MAXA(E1:E5)', 5],
        ['=MAXA(E4)', 1],
        ['=MAXA(F1:F3)', 0],
        ['=MAXA(Z1:Z3)', 0],
        ['=MAXA(-5,B5)', 0],
        ['=MAXA(E1:E8)', DIV0],
        ['=MINA(E1:E5)', 0],
        ['=MINA(D1:D8,B3)', 1],
        ['=MINA(D1:D8,B2)', 0],
        ['=MINA(Z9)', 0],
        ['=MINA(TRUE,5)', 1],
        ['=MINA(E1:E8)', DIV0],
    ]);
});

describe('GEOMEAN, HARMEAN, AVEDEV and DEVSQ', () => {
    recorded('the means of positive numbers', [
        ['=GEOMEAN(D1:D8)', 2.9953451699808],
        ['=GEOMEAN(TRUE,5)', 2.23606797749979],
        ['=GEOMEAN((D1:D3,D5:D8),10)', 3.9943569808963],
        ['=GEOMEAN(1,2,3,4,5,6,7,8,9,10)', 4.52872868811676],
        ['=GEOMEAN(1E+200,1E+200,1E-200)', 4.64158883361278e66],
        ['=GEOMEAN(0)', NUM],
        ['=GEOMEAN(-1,1)', NUM],
        ['=GEOMEAN(5,)', NUM],
        ['=GEOMEAN(F1:F3)', NUM],
        ['=GEOMEAN(Z9)', NUM],
        ['=GEOMEAN(E1:E8)', DIV0],
        ['=HARMEAN(D1:D8)', 2.24648985959438],
        ['=HARMEAN(1,2,3,4)', 1.92],
        ['=HARMEAN(A5,A5)', 1e300],
        ['=HARMEAN(0)', NUM],
        ['=HARMEAN(-5,5)', NUM],
        ['=HARMEAN(5,)', NUM],
        ['=HARMEAN(A1:A5)', NUM],
        ['=HARMEAN(E1:E8)', DIV0],
    ]);
    test.each([
        ['=GEOMEAN(5)', 5],
        ['=GEOMEAN(5,5)', 5],
        ['=INT(GEOMEAN(5,5))', 5],
        ['=GEOMEAN(3,3,3)', 3],
        ['=GEOMEAN(7,7,7,7,7)', 7],
        ['=GEOMEAN(2,8)', 4],
        ['=INT(GEOMEAN(76,19))', 38],
        ['=GEOMEAN(A5)', 1e300],
        ['=GEOMEAN(A5,A5)', 1e300],
        ['=GEOMEAN(1E+300,1E+300)', 1e300],
        ['=GEOMEAN(1E-300,1E-300)', 1e-300],
        ['=GEOMEAN(1E+200,1E+200)', 1e200],
        ['=GEOMEAN(1E+154,1E+154)', 1e154],
        ['=GEOMEAN(J1:J5)', 5],
        ['=HARMEAN(3,3,3)', 3],
    ])('a mean of equal numbers, or of a whole power, is the number itself: %s is %p', (formula, expected) => {
        expect(evaluate(formula, RECORDED, 'Q1')).toBe(expected);
    });
    recorded(
        'HARMEAN refuses an element that is a reference, GEOMEAN takes its first cell',
        [
            ['=HARMEAN(OFFSET(A1,{0;1;2},0,2))', VALUE],
            ['=GEOMEAN(OFFSET(A1,{0;1;2},0,2))', 18.1712059283214],
        ],
        { A1: 10, A2: 20, A3: 30, A4: 40 },
    );
    recorded('HARMEAN of no number at all is #N/A, where the others say #NUM!', [
        ['=HARMEAN(F1:F3)', NA],
        ['=HARMEAN(Z9)', NA],
        ['=HARMEAN(B2)', NA],
    ]);
    recorded('the distances to the mean', [
        ['=AVEDEV(D1:D8)', 2.125],
        ['=AVEDEV(D1:D8,)', 2.2716049382716],
        ['=AVEDEV(5)', 0],
        ['=AVEDEV(A1:A5)', 3.2e299],
        ['=AVEDEV(1E+200,1E+200)', 0],
        ['=AVEDEV(F1:F3)', NUM],
        ['=AVEDEV(B6)', NUM],
        ['=AVEDEV(E1:E8)', DIV0],
        ['=DEVSQ(D1:D8)', 52.875],
        ['=DEVSQ(5)', 0],
        ['=DEVSQ(A5,A5)', 0],
        ['=DEVSQ(1E+154,1E+154)', 0],
        ['=DEVSQ(A1:A5)', NUM],
        ['=DEVSQ(Z1:Z3)', NUM],
        ['=DEVSQ(E2)', NUM],
        ['=DEVSQ(E1:E8)', DIV0],
    ]);
});

describe('two ranges paired place by place', () => {
    recorded('COVARIANCE.P and COVARIANCE.S', [
        ['=COVARIANCE.P(D1:D8,H1:H8)', 1.703125],
        ['=COVARIANCE.P(D1:D8,D1:D8)', 6.609375],
        ['=COVARIANCE.P({1,2,3},{5,5,5})', 0],
        ['=COVARIANCE.P({1},{2})', 0],
        ['=COVARIANCE.P(5,7)', 0],
        ['=COVARIANCE.P(D1:D5,E1:E5)', 1],
        ['=COVARIANCE.P(A1:A5,D1:D5)', 4.4e299],
        ['=COVARIANCE.P(Z1:Z3,Z1:Z3)', DIV0],
        ['=COVARIANCE.P(D1:D3,F1:F3)', DIV0],
        ['=COVARIANCE.P(TRUE,1)', DIV0],
        ['=COVARIANCE.P(D1:D8,E1:E8)', DIV0],
        ['=COVARIANCE.P(D1:D8,H1:H7)', NA],
        ['=COVARIANCE.P(D1:D8,)', VALUE],
        ['=COVARIANCE.S(D1:D8,H1:H8)', 1.94642857142857],
        ['=COVARIANCE.S(D1:D5,E1:E5)', 2],
        ['=COVARIANCE.S(D1:D2,H1:H2)', -5],
        ['=COVARIANCE.S({1,2,3},{5,5,5})', 0],
        ['=COVARIANCE.S({1},{2})', DIV0],
        ['=COVARIANCE.S(5,7)', DIV0],
        ['=COVARIANCE.S(F1:F3,F1:F3)', DIV0],
        ['=COVARIANCE.S(A1:A5,D1:D5)', 5.5e299],
        ['=COVAR(D1:D8,H1:H8)', 1.703125],
    ]);
    recorded('SLOPE and INTERCEPT take the y values first', [
        ['=SLOPE(D1:D8,H1:H8)', 0.170579029733959],
        ['=SLOPE(I1:I8,D1:D8)', 0.425531914893617],
        ['=SLOPE(D1:D8,I1:I8)', 0.535714285714286],
        ['=SLOPE({1,2},{3,5})', 0.5],
        ['=SLOPE({5,5,5},{1,2,3})', 0],
        ['=SLOPE({1,2,3},{5,5,5})', DIV0],
        ['=SLOPE({1},{2})', DIV0],
        ['=SLOPE(Z1:Z3,Z1:Z3)', DIV0],
        ['=SLOPE(A1:A5,D1:D5)', 1.71875e299],
        ['=SLOPE(D1:D8,E1:E8)', DIV0],
        ['=SLOPE(D1:D8,E1:E5)', NA],
        ['=INTERCEPT(D1:D8,H1:H8)', 3.08607198748044],
        ['=INTERCEPT(I1:I8,D1:D8)', 2.85106382978723],
        ['=INTERCEPT({1,2},{3,5})', -0.5],
        ['=INTERCEPT({5,5,5},{1,2,3})', 5],
        ['=INTERCEPT({1,2,3},{5,5,5})', DIV0],
        ['=INTERCEPT(5,7)', DIV0],
        ['=INTERCEPT(A1:A5,D1:D5)', -2.8125e299],
        ['=INTERCEPT(,D1:D8)', VALUE],
    ]);
    recorded('CORREL', [
        ['=CORREL(D1:D8,H1:H8)', 0.209655319073012],
        ['=CORREL(D1:D8,D1:D8)', 1],
        ['=CORREL(D1:D2,H1:H2)', -1],
        ['=CORREL(D1:D5,J1:J5)', DIV0],
        ['=CORREL(Z1:Z3,Z1:Z3)', DIV0],
        ['=CORREL(A1:A5,D1:D5)', NUM],
    ]);
});

// X in A1:A5 and Y in B1:B5.
const NO_THIRD: Cells = { A1: 10, A2: 20, A4: 40, A5: 50, B1: 12, B2: 19, B3: 33, B4: 38, B5: 55 };
const PAIRED: Cells = { ...NO_THIRD, A3: 30 };
const WITHOUT_THIRD: readonly Row[] = [
    ['=RSQ(B1:B5,A1:A5)', 0.975663716814159],
    ['=PEARSON(A1:A5,B1:B5)', 0.987756911802777],
    ['=SUMXMY2(A1:A5,B1:B5)', 34],
    ['=SUMX2MY2(A1:A5,B1:B5)', -374],
    ['=SUMX2PY2(A1:A5,B1:B5)', 9574],
    ['=STEYX(B1:B5,A1:A5)', 3.70809924354783],
    ['=FORECAST(60,B1:B5,A1:A5)', 62.5],
    ['=FORECAST.LINEAR(60,B1:B5,A1:A5)', 62.5],
    ['=SLOPE(B1:B5,A1:A5)', 1.05],
    ['=INTERCEPT(B1:B5,A1:A5)', -0.5],
    ['=COVAR(A1:A5,B1:B5)', 262.5],
];

describe('RSQ, PEARSON, STEYX, FORECAST and the sums of squares', () => {
    recorded(
        'five pairs',
        [
            ['=RSQ(B1:B5,A1:A5)', 0.972908577479704],
            ['=PEARSON(A1:A5,B1:B5)', 0.986361281417566],
            ['=SUMXMY2(A1:A5,B1:B5)', 43],
            ['=SUMX2MY2(A1:A5,B1:B5)', -563],
            ['=SUMX2PY2(A1:A5,B1:B5)', 11563],
            ['=STEYX(B1:B5,A1:A5)', 3.19895816373602],
            ['=FORECAST(60,B1:B5,A1:A5)', 62.9],
            ['=FORECAST.LINEAR(60,B1:B5,A1:A5)', 62.9],
            ['=SLOPE(B1:B5,A1:A5)', 1.05],
            ['=INTERCEPT(B1:B5,A1:A5)', -0.100000000000001],
            ['=COVAR(A1:A5,B1:B5)', 210],
        ],
        PAIRED,
    );
    recorded(
        'a side that is one cell shorter',
        [
            ['=RSQ(B1:B5,A1:A4)', NA],
            ['=PEARSON(A1:A4,B1:B5)', NA],
            ['=SUMXMY2(A1:A4,B1:B5)', NA],
            ['=SUMX2MY2(A1:A4,B1:B5)', NA],
            ['=SUMX2PY2(A1:A4,B1:B5)', NA],
            ['=STEYX(B1:B5,A1:A4)', NA],
            ['=FORECAST(60,B1:B5,A1:A4)', NA],
            ['=FORECAST.LINEAR(60,B1:B5,A1:A4)', NA],
            ['=SLOPE(B1:B5,A1:A4)', NA],
            ['=INTERCEPT(B1:B5,A1:A4)', NA],
            ['=COVAR(A1:A4,B1:B5)', NA],
            ['=RSQ(B1:B4,A1:A5)', NA],
            ['=PEARSON(A1:A5,B1:B4)', NA],
            ['=SUMXMY2(A1:A5,B1:B4)', NA],
            ['=SUMX2MY2(A1:A5,B1:B4)', NA],
            ['=SUMX2PY2(A1:A5,B1:B4)', NA],
            ['=STEYX(B1:B4,A1:A5)', NA],
            ['=FORECAST(60,B1:B4,A1:A5)', NA],
            ['=FORECAST.LINEAR(60,B1:B4,A1:A5)', NA],
            ['=SLOPE(B1:B4,A1:A5)', NA],
            ['=INTERCEPT(B1:B4,A1:A5)', NA],
            ['=COVAR(A1:A5,B1:B4)', NA],
        ],
        PAIRED,
    );
    recorded(
        'one range on both sides',
        [
            ['=RSQ(A1:A5,A1:A5)', 1],
            ['=PEARSON(A1:A5,A1:A5)', 1],
            ['=SUMXMY2(A1:A5,A1:A5)', 0],
            ['=SUMX2MY2(A1:A5,A1:A5)', 0],
            ['=SUMX2PY2(A1:A5,A1:A5)', 11000],
            ['=STEYX(A1:A5,A1:A5)', 0],
            ['=FORECAST(60,A1:A5,A1:A5)', 60],
            ['=FORECAST.LINEAR(60,A1:A5,A1:A5)', 60],
            ['=SLOPE(A1:A5,A1:A5)', 1],
            ['=INTERCEPT(A1:A5,A1:A5)', 0],
            ['=COVAR(A1:A5,A1:A5)', 200],
        ],
        PAIRED,
    );
    recorded('array constants', [
        ['=RSQ({2,4,7},{1,2,3})', 0.986842105263158],
        ['=PEARSON({1,2,3},{2,4,7})', 0.993399267798783],
        ['=SUMXMY2({1,2,3},{2,4,7})', 21],
        ['=SUMX2MY2({1,2,3},{2,4,7})', -55],
        ['=SUMX2PY2({1,2,3},{2,4,7})', 83],
        ['=STEYX({2,4,7},{1,2,3})', 0.408248290463862],
        ['=FORECAST(60,{2,4,7},{1,2,3})', 149.333333333333],
        ['=FORECAST.LINEAR(60,{2,4,7},{1,2,3})', 149.333333333333],
        ['=SLOPE({2,4,7},{1,2,3})', 2.5],
        ['=INTERCEPT({2,4,7},{1,2,3})', -0.666666666666667],
        ['=COVAR({1,2,3},{2,4,7})', 1.66666666666667],
    ]);
    recorded(
        'one pair',
        [
            ['=RSQ(B1,A1)', DIV0],
            ['=PEARSON(A1,B1)', DIV0],
            ['=SUMXMY2(A1,B1)', 4],
            ['=SUMX2MY2(A1,B1)', -44],
            ['=SUMX2PY2(A1,B1)', 244],
            ['=STEYX(B1,A1)', DIV0],
            ['=FORECAST(60,B1,A1)', DIV0],
            ['=FORECAST.LINEAR(60,B1,A1)', DIV0],
            ['=SLOPE(B1,A1)', DIV0],
            ['=INTERCEPT(B1,A1)', DIV0],
            ['=COVAR(A1,B1)', 0],
        ],
        PAIRED,
    );
    recorded('a pair with a text is left out', WITHOUT_THIRD, { ...NO_THIRD, A3: 'x' });
    recorded('a pair with a blank is left out', WITHOUT_THIRD, NO_THIRD);
    recorded(
        'an error in a range is the answer',
        [
            ['=RSQ(B1:B5,A1:A5)', DIV0],
            ['=PEARSON(A1:A5,B1:B5)', DIV0],
            ['=SUMXMY2(A1:A5,B1:B5)', DIV0],
            ['=SUMX2MY2(A1:A5,B1:B5)', DIV0],
            ['=SUMX2PY2(A1:A5,B1:B5)', DIV0],
            ['=STEYX(B1:B5,A1:A5)', DIV0],
            ['=FORECAST(60,B1:B5,A1:A5)', DIV0],
            ['=FORECAST.LINEAR(60,B1:B5,A1:A5)', DIV0],
            ['=SLOPE(B1:B5,A1:A5)', DIV0],
            ['=INTERCEPT(B1:B5,A1:A5)', DIV0],
            ['=COVAR(A1:A5,B1:B5)', DIV0],
        ],
        { ...PAIRED, A3: '=1/0' },
    );
});

// Excel batch 13, part 2c: three uneven sets, one a million off zero, each answer in all 15 digits. RSQ of the
// third set is one digit under the square of its CORREL, which says in what order Excel divides.
describe('the order of operations on uneven data', () => {
    recorded(
        'batch 13',
        [
            ['=RSQ(B1:B6,A1:A6)', 0.966945888579307],
            ['=CORREL(A1:A6,B1:B6)', 0.983334067638922],
            ['=PEARSON(A1:A6,B1:B6)', 0.983334067638922],
            ['=CORREL(A1:A6,B1:B6)^2', 0.966945888579307],
            ['=SLOPE(B1:B6,A1:A6)', 1.89682471388004],
            ['=INTERCEPT(B1:B6,A1:A6)', 0.0668014800791683],
            ['=STEYX(B1:B6,A1:A6)', 0.771711526398245],
            ['=COVARIANCE.P(A1:A6,B1:B6)', 6.12305555555556],
            ['=COVARIANCE.S(A1:A6,B1:B6)', 7.34766666666667],
            ['=VAR.P(A1:A6)', 3.22805555555556],
            ['=VAR.S(A1:A6)', 3.87366666666667],
            ['=STDEV.P(B1:B6)', 3.46574506980662],
            ['=FORECAST(7,B1:B6,A1:A6)', 13.3445744772395],
            ['=RSQ(B1:B6,C1:C6)', 0.809764368353611],
            ['=CORREL(C1:C6,B1:B6)', 0.899869084008119],
            ['=PEARSON(C1:C6,B1:B6)', 0.899869084008119],
            ['=CORREL(C1:C6,B1:B6)^2', 0.809764368353611],
            ['=SLOPE(B1:B6,C1:C6)', 11.0842105259408],
            ['=INTERCEPT(B1:B6,C1:C6)', -11084208.3971688],
            ['=STEYX(B1:B6,C1:C6)', 1.85134848916737],
            ['=COVARIANCE.P(C1:C6,B1:B6)', 0.877500000013323],
            ['=COVARIANCE.S(C1:C6,B1:B6)', 1.05300000001599],
            ['=VAR.P(C1:C6)', 0.0791666666705472],
            ['=VAR.S(C1:C6)', 0.0950000000046566],
            ['=STDEV.P(B1:B6)', 3.46574506980662],
            ['=FORECAST(7,B1:B6,C1:C6)', -11084130.8076952],
            ['=RSQ(E1:E4,D1:D4)', 0.821229050279329],
            ['=CORREL(D1:D4,E1:E4)', -0.906216889204416],
            ['=PEARSON(D1:D4,E1:E4)', -0.906216889204416],
            ['=CORREL(D1:D4,E1:E4)^2', 0.82122905027933],
            ['=SLOPE(E1:E4,D1:D4)', -3.5195530726257],
            ['=INTERCEPT(E1:E4,D1:D4)', 3.92178770949721],
            ['=STEYX(E1:E4,D1:D4)', 0.776757333603786],
            ['=COVARIANCE.P(D1:D4,E1:E4)', -0.39375],
            ['=COVARIANCE.S(D1:D4,E1:E4)', -0.525],
            ['=VAR.P(D1:D4)', 0.111875],
            ['=VAR.S(D1:D4)', 0.149166666666667],
            ['=STDEV.P(E1:E4)', 1.29903810567666],
            ['=FORECAST(7,E1:E4,D1:D4)', -20.7150837988827],
        ],
        {
            ...{ A1: 1.1, A2: 2.3, A3: 2.9, A4: 4.2, A5: 5.7, A6: 6.1 },
            ...{ B1: 2.2, B2: 3.9, B3: 6.1, B4: 8.3, B5: 9.8, B6: 12.4 },
            ...{ C1: 1000000.1, C2: 1000000.3, C3: 1000000.2, C4: 1000000.7, C5: 1000000.5, C6: 1000000.9 },
            ...{ D1: 0.1, D2: 0.7, D3: 0.2, D4: 0.9, E1: 3, E2: 1, E3: 4, E4: 1 },
        },
    );
});

// Excel batch 13, part 1.
describe('too few pairs to divide by', () => {
    recorded('batch 13', [
        ['=STEYX({1,2},{3,5})', DIV0],
        ['=SUMXMY2(Z1:Z3,Z1:Z3)', DIV0],
    ]);
});

describe('SUBTOTAL picks the deviation and the variance by 7, 8, 10 and 11', () => {
    recorded('SUBTOTAL', [
        ['=SUBTOTAL(7,D1:D8)', 2.74837614393871],
        ['=SUBTOTAL(8,D1:D8)', 2.57087047515039],
        ['=SUBTOTAL(10,D1:D8)', 7.55357142857143],
        ['=SUBTOTAL(11,D1:D8)', 6.609375],
        ['=SUBTOTAL(107,D1:D8)', 2.74837614393871],
        ['=SUBTOTAL(111,D1:D8)', 6.609375],
        ['=SUBTOTAL(7,E1:E5)', Math.SQRT2],
        ['=SUBTOTAL(8,E1:E5)', 1],
        ['=SUBTOTAL(10,E1:E8)', DIV0],
    ]);
});
