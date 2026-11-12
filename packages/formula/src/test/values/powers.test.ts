import { describe, expect, test } from 'bun:test';
import { DIV0, NUM } from '../../index';
import { evaluate } from '../recalc/support';

describe('the power operator and POWER', () => {
    test.each([
        ['1E-200', '-2', DIV0],
        ['-1', '1E+15', NUM],
        ['-8', '1/3', -2],
        ['-8', '-1/3', -0.5],
        ['-32', '0.2', -2],
        ['-8', '2/3', NUM],
        ['0', '0', NUM],
        ['0', '-1', DIV0],
        ['-1', '2^31-1', -1],
        ['-1', '2^31', 1],
        ['2', '1024', NUM],
        ['2', '-1075', 0],
        ['10', '308', 1e308],
        ['10', '309', NUM],
        ['-2', '0.5', NUM],
        ['1E+200', '2', NUM],
        ['-8', '0.333333333333333', -2],
        ['-8', '0.33333333333333', NUM],
        ['0', '2', 0],
        ['-2', '3', -8],
        ['-2', '-3', -0.125],
        ['2', '-1022', 2.2250738585072e-308],
        ['4', '0.5', 2],
    ])('%s to the power %s is %p, written either way', (base, exponent, expected) => {
        for (const formula of [`=(${base})^(${exponent})`, `=POWER(${base},${exponent})`]) {
            const value = evaluate(formula);
            expect(typeof value === 'number' ? Number(value.toPrecision(15)) : value).toBe(expected);
        }
    });

    test.each([
        ['3', 75n],
        ['3', 100n],
        ['11', 32n],
        ['12', 34n],
        ['7', 18n],
        ['-3', 99n],
        ['1.5', 60n],
        ['49667', 65n],
    ])('a whole power of %s is the nearest number to the exact one', (base, exponent) => {
        const [top, bottom] = base === '1.5' ? [3n, 2n] : [BigInt(base), 1n];
        const exact = Number(top ** exponent) / Number(bottom ** exponent);
        expect(evaluate(`=(${base})^${exponent}`)).toBe(exact);
        expect(evaluate(`=POWER(${base},${exponent})`)).toBe(exact);
        const under = Number(`${(10n ** 400n * bottom ** exponent) / top ** exponent}e-400`);
        expect(evaluate(`=POWER(${base},-${exponent})`)).toBe(under);
    });

    test('a whole exponent past every digit still has a power of a positive base', () => {
        expect(evaluate('=1^1E+300')).toBe(1);
        expect(evaluate('=POWER(2,1E+300)')).toBe(NUM);
        expect(evaluate('=POWER(0.5,1E+300)')).toBe(0);
        expect(evaluate('=POWER(2,-1E+300)')).toBe(0);
        expect(evaluate('=0.5^(-1E+300)')).toBe(DIV0);
    });
});
