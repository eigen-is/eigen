import { describe, expect, test } from 'bun:test';
import { DIV0, NA, NUM, VALUE } from '../../index';
import type { Cells } from '../recalc/support';
import { engineOf, evaluate, valueAt } from '../recalc/support';

// Excel batch 3, sheet b3_e: A1:A3 = 1, #DIV/0!, 3, B1:B3 = #N/A, 2, 3, C1:C3 = 10, 20, 30.
const E: Cells = { A1: 1, A2: '=1/0', A3: 3, B1: '=NA()', B2: 2, B3: 3, C1: 10, C2: 20, C3: 30 };

describe('SUMPRODUCT: any argument’s error in argument order, then the sizes, then the products', () => {
    test.each([
        ['=SUMPRODUCT(A1:A3,B1:B3)', DIV0],
        ['=SUMPRODUCT(B1:B3,A1:A3)', NA],
        ['=SUMPRODUCT(B1:B3,C1:C2)', NA],
        ['=SUMPRODUCT(C1:C3,B1:B2)', NA],
        ['=SUMPRODUCT(B1:B3,2)', NA],
        ['=SUMPRODUCT(C1:C3,B2:B3)', VALUE],
        ['=SUMPRODUCT(C1:C3,2)', VALUE],
        ['=SUMPRODUCT(C1:C3,"2")', VALUE],
        ['=SUMPRODUCT(C1:C3,NA())', NA],
        ['=SUMPRODUCT(NA(),A1:A3)', NA],
        ['=SUMPRODUCT("2",3)', 0],
        ['=SUMPRODUCT(2,3)', 6],
        ['=SUMPRODUCT((C1:C3,B2:B3))', VALUE],
        ['=SUMPRODUCT(C1:C3,C1:C3)', 1400],
        ['=SUMPRODUCT(INDEX(C1:C3,{1,2,3}))', 0],
    ])('%s', (formula, expected) => {
        expect(evaluate(formula, E)).toBe(expected);
    });
});

describe('no collector hands the adder a number that is none', () => {
    // A product that overflows is #NUM! where it is made: this formula over all 16,384 columns ran for a minute.
    test('products of 1E200 that overflow are #NUM! at once', () => {
        const formula = '=SUMPRODUCT(Sheet2!A:CV*1,Sheet2!A:CV*1,Sheet2!A:CV*-1)';
        const engine = engineOf({
            s1: { A1: formula, A2: '=SUMPRODUCT(Sheet2!A1:A2,Sheet2!A1:A2,Sheet2!A1:A2)' },
            s2: { A1: 1e200, A2: -1e200 },
        });
        const started = performance.now();
        engine.recalc(Number.POSITIVE_INFINITY);
        expect(valueAt(engine, 'A1')).toBe(NUM);
        expect(valueAt(engine, 'A2')).toBe(NUM);
        expect(performance.now() - started).toBeLessThan(2000);
    });

    test.each([
        ['=SUM((B:B="")*1E308)', NUM],
        ['=SUM(A:CV*1E108)', 0],
        ['=AVERAGE((B:B="")*1E308)', NUM],
        ['=AVERAGE(A:CV*1E108)', 0],
        ['=MAX(A:CV*1E108)', 1e308],
        ['=MIN(A:CV*1E108)', -1e308],
        ['=COUNT(A:CV*1E108)', 104857600],
        ['=COUNTA(A:CV*1E108)', 104857600],
        ['=AND(A:CV*1E108)', false],
        ['=OR(A:A*1E108)', true],
        ['=SUMIF(A1:A2,"<>x")', 0],
        ['=SUM(A1:A2*1E200)', NUM],
    ])('%s', (formula, expected) => {
        const started = performance.now();
        expect(evaluate(formula, { A1: 1e200, A2: -1e200 }, 'DA1')).toBe(expected);
        expect(performance.now() - started).toBeLessThan(2000);
    });
});
