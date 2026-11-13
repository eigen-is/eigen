import { describe, expect, test } from 'bun:test';
import { fixedText, numberToText } from '../../values/number-text';
import { parseNumber } from '../../values/parse-number';
import { round15 } from '../../values/precision';

const shown = (cases: [number, string][]) => {
    for (const [n, text] of cases) expect([n, numberToText(n)]).toEqual([n, text]);
};

describe('numberToText', () => {
    test("the oracle's answers", () => {
        shown([
            [1 / 3, '0.333333333333333'],
            [2 / 3, '0.666666666666667'],
            [0.1 + 0.2, '0.3'],
            [1e20, '1E+20'],
            [123456789012, '123456789012'],
            [43861, '43861'],
            [0.1 + 0.2 - 0.3, '5.55111512312578E-17'],
        ]);
        expect(numberToText(1 / 3).length).toBe(17);
    });

    test('whole numbers, signs and zero', () => {
        shown([
            [0, '0'],
            [-0, '0'],
            [1, '1'],
            [-1, '-1'],
            [123, '123'],
            [-1234.5, '-1234.5'],
            [1.5, '1.5'],
            [0.5, '0.5'],
            [-0.25, '-0.25'],
            [123456789012345, '123456789012345'],
            [100, '100'],
            [1e14, '100000000000000'],
            [-2 / 3, '-0.666666666666667'],
        ]);
    });

    test('15 significant digits and no zeros after them', () => {
        shown([
            [1.005, '1.005'],
            [4.1 - 4, '0.0999999999999996'],
            [1000000000000000.2, '1000000000000000'],
            [1234567890123456, '1234567890123460'],
            [123456789012345680, '123456789012346000'],
            [0.30000000000000004, '0.3'],
            [9.999999999999998, '10'],
            [0.9999999999999999, '1'],
            [99999999999999.98, '100000000000000'],
            [1.0000000000000002, '1'],
        ]);
    });

    test('plain digits up to 20 characters, scientific notation past them', () => {
        shown([
            [1e15, '1000000000000000'],
            [1e19, '10000000000000000000'],
            [1.23456789012345e19, '12345678901234500000'],
            [1e20, '1E+20'],
            [1.23456789012346e21, '1.23456789012346E+21'],
            [1e-7, '0.0000001'],
            [1e-15, '0.000000000000001'],
            [1e-18, '0.000000000000000001'],
            [1e-19, '1E-19'],
            [1.5e-18, '1.5E-18'],
            [1.5e-19, '1.5E-19'],
            [1.23456789012345e-18, '1.23456789012345E-18'],
            [0.000123456789012345, '0.000123456789012345'],
            [0.0000123456789012345, '1.23456789012345E-05'],
            [-1e20, '-1E+20'],
            [-1e-18, '-0.000000000000000001'],
            [-1e-19, '-1E-19'],
        ]);
    });

    test('Excel batch 3: what a typed literal gives as text', () => {
        shown([
            [1e-11, '0.00000000001'],
            [1e-12, '0.000000000001'],
            [1e-13, '0.0000000000001'],
            [1e-14, '0.00000000000001'],
            [1e-15, '0.000000000000001'],
            [1e-16, '0.0000000000000001'],
            [1e-17, '0.00000000000000001'],
            [1e-18, '0.000000000000000001'],
            [1e-19, '1E-19'],
            [1e-20, '1E-20'],
            [1e-21, '1E-21'],
            [1e15, '1000000000000000'],
            [1e16, '10000000000000000'],
            [1e19, '10000000000000000000'],
            [1e20, '1E+20'],
            [1e21, '1E+21'],
            [1e22, '1E+22'],
            [123456789012345000, '123456789012345000'],
            [0.000000000000123456, '0.000000000000123456'],
            [1.5e-14, '0.000000000000015'],
            [1.5e25, '1.5E+25'],
            [0.00000000000001, '0.00000000000001'],
            [100000000000000000000, '1E+20'],
            [1000000000000000000000, '1E+21'],
            [-1e-14, '-0.00000000000001'],
            [1e14, '100000000000000'],
        ]);
    });

    test('the exponent has at least two digits', () => {
        shown([
            [1.5e-5 / 1e15, '1.5E-20'],
            [3.14159265358979e-5, '3.14159265358979E-05'],
            [1e100, '1E+100'],
            [1.7976931348623157e308, '1.79769313486232E+308'],
            [5e-324, '4.94065645841247E-324'],
            [2.5e25, '2.5E+25'],
        ]);
    });

    test('the text reads back as the number at 15 digits', () => {
        let state = 20;
        const random = () => {
            state = (Math.imul(state, 1103515245) + 12345) | 0;
            return (state >>> 8) / 16777216;
        };
        for (let i = 0; i < 20000; i += 1) {
            const n = (random() - 0.5) * 10 ** Math.floor(random() * 60 - 30);
            expect([n, parseNumber(numberToText(n))]).toEqual([n, round15(n)]);
        }
    });
});

describe('fixedText', () => {
    test('exactly that many digits after the point, and none at 0 or below', () => {
        expect(fixedText(1234.57, 2, false)).toBe('1234.57');
        expect(fixedText(1234.5, 3, false)).toBe('1234.500');
        expect(fixedText(1235, 0, false)).toBe('1235');
        expect(fixedText(1200, -2, false)).toBe('1200');
        expect(fixedText(0, 2, false)).toBe('0.00');
        expect(fixedText(0.05, 2, false)).toBe('0.05');
        expect(fixedText(0.000123, 6, false)).toBe('0.000123');
        expect(fixedText(-0.5, 1, false)).toBe('-0.5');
    });

    test('a comma between every three digits before the point', () => {
        expect(fixedText(999, 0, true)).toBe('999');
        expect(fixedText(1000, 0, true)).toBe('1,000');
        expect(fixedText(-123456.5, 1, true)).toBe('-123,456.5');
        expect(fixedText(1234567, 2, true)).toBe('1,234,567.00');
    });

    test('the 15 digits Excel holds, and zeros after them', () => {
        expect(fixedText(5e20, 2, false)).toBe('500000000000000000000.00');
        expect(fixedText(1e21, 0, true)).toBe('1,000,000,000,000,000,000,000');
        expect(fixedText(1.2345678901234568e17, 0, false)).toBe('123456789012346000');
        expect(fixedText(1 / 3, 20, false)).toBe('0.33333333333333300000');
        expect(fixedText(1e300, 0, false).length).toBe(301);
    });
});
