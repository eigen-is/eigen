import { describe, expect, test } from 'bun:test';
import { createArrayResolver } from '../../../../../../engine/cell-resolver';
import { FormulaEngine } from '../../../../../../engine/formula-engine';
import { DOTTED_FUNCTIONS } from '../../../../../../engine/parser/evaluate-by-operator/operator/formula-function';
import type { Cell } from '../../../../../../engine/types';

// One column per data set of Microsoft's examples, top-aligned.
const COLUMNS = [
    [1345, 1301, 1368, 1322, 1310, 1370, 1318, 1350, 1303, 1299], // A: STDEV.S, VAR.S
    [1, 3, 2, 4], // B: PERCENTILE.INC
    [7, 3.5, 3.5, 1, 2], // C: RANK.EQ
    [1, 2, 4, 7, 8, 9, 10, 12], // D: QUARTILE.INC
    [2, 4, 8], // E: COVARIANCE.S
    [5, 11, 12], // F
    [5.6, 4, 4, 3, 2, 4], // G: MODE.SNGL
];

function column(c: number): (Cell | null)[] {
    return Array.from({ length: 10 }, (_, r) => {
        const v = COLUMNS[c][r];
        return v === undefined ? null : { v, ct: { t: 'n', fa: 'General' } };
    });
}

const resolver = createArrayResolver([
    {
        id: 's1',
        name: 'Sheet1',
        data: Array.from({ length: 10 }, (_, r) => COLUMNS.map((_, c) => column(c)[r])),
        calculationChain: [],
        dynamicArrayCompute: [],
    },
]);

const engine = new FormulaEngine();
const value = (formula: string) => engine.evaluate(formula, 's1', resolver).value;
// Microsoft's examples round their results; match to the digits they show.
const near = (formula: string, expected: number, digits: number) =>
    expect(value(formula)).toBeCloseTo(expected, digits);

describe("Excel's dotted function names", () => {
    test('statistics: STDEV.S, VAR.P, PERCENTILE.INC, QUARTILE.INC, RANK.EQ, MODE.SNGL, COVARIANCE.S', () => {
        near('=STDEV.S(A1:A10)', 27.46392, 5);
        near('=STDEV.P(A1:A10)', 26.05456, 5);
        near('=VAR.P(A1:A10)', 678.84, 2);
        near('=PERCENTILE.INC(B1:B4,0.3)', 1.9, 9);
        expect(value('=QUARTILE.INC(D1:D8,1)')).toBe(3.5);
        expect(value('=RANK.EQ(7,C1:C5,1)')).toBe(5);
        expect(value('=RANK.EQ(2,C1:C5)')).toBe(4);
        expect(value('=MODE.SNGL(G1:G6)')).toBe(4);
        near('=COVARIANCE.S(E1:E3,F1:F3)', 9.666666667, 9);
    });

    test('distributions: NORM.DIST, NORM.S.INV, T.DIST.2T, BINOM.DIST, CHISQ.DIST.RT, POISSON.DIST', () => {
        near('=NORM.DIST(42,40,1.5,TRUE)', 0.9087888, 7);
        near('=NORM.DIST(42,40,1.5,FALSE)', 0.10934, 5);
        near('=NORM.S.INV(0.908789)', 1.3333347, 7);
        near('=T.DIST.2T(1.959999998,60)', 0.054645, 6);
        near('=BINOM.DIST(6,10,0.5,FALSE)', 0.2050781, 7);
        near('=CHISQ.DIST.RT(18.307,10)', 0.0500006, 7);
        near('=POISSON.DIST(2,5,TRUE)', 0.124652, 6);
    });

    test('rounding: CEILING.MATH and FLOOR.MATH, an omitted significance being 1', () => {
        expect(value('=CEILING.MATH(24.3,5)')).toBe(25);
        expect(value('=CEILING.MATH(6.7)')).toBe(7);
        expect(value('=CEILING.MATH(-8.1,2)')).toBe(-8);
        expect(value('=CEILING.MATH(-5.5,2,-1)')).toBe(-6);
        expect(value('=FLOOR.MATH(6.7)')).toBe(6);
        expect(value('=FLOOR.MATH(-5.5,2,-1)')).toBe(-4);
        expect(value('=CEILING.PRECISE(-4.3)')).toBe(-4);
        expect(value('=CEILING.PRECISE(4.3,-2)')).toBe(6);
        expect(value('=FLOOR.PRECISE(-3.2,-1)')).toBe(-4);
        expect(value('=ISO.CEILING(4.3)')).toBe(5);
    });

    test('dates: NETWORKDAYS.INTL and WORKDAY.INTL', () => {
        expect(value('=NETWORKDAYS.INTL(DATE(2006,1,1),DATE(2006,1,31))')).toBe(22);
        expect(value('=WORKDAY.INTL(DATE(2012,1,1),90,11)')).toBe(41013);
        expect(value('=WORKDAY.INTL(DATE(2012,1,1),30,17)')).toBe(40944);
    });

    test('engineering and information: ERF.PRECISE, ERFC.PRECISE, ERROR.TYPE', () => {
        near('=ERF.PRECISE(0.745)', 0.70792892, 8);
        near('=ERFC.PRECISE(1)', 0.15729921, 8);
        expect(value('=ERROR.TYPE(1/0)')).toBe(2);
        expect(value('=ERROR.TYPE(NA())')).toBe(7);
    });

    test('a name matches in any case', () => {
        near('=stdev.s(A1:A10)', 27.46392, 5);
        near('=Norm.S.Dist(1.333333,TRUE)', 0.908788726, 9);
    });

    test('every registered name reaches a formulajs function', () => {
        for (const name of DOTTED_FUNCTIONS) expect(value(`=${name}()`)).not.toBe('#NAME?');
    });

    test('a nested path Excel does not know, or one formulajs gets wrong, is #NAME?', () => {
        expect(value('=STDEVS.P(A1:A10)')).toBe('#NAME?');
        expect(value('=CEILINGMATH.MATH(6.7)')).toBe('#NAME?');
        expect(value('=T.DIST(1,2,TRUE)')).toBe('#NAME?');
    });

    test('the undotted names resolve as before', () => {
        near('=STDEV(A1:A10)', 27.46392, 5);
        expect(value('=NORM(1)')).toBe('#NAME?');
    });
});
