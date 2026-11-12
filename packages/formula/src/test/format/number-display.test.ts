import { describe, expect, test } from 'bun:test';
import { numberDisplay } from '../../format';
import { valueAsText } from '../../format/number-display';
import { grouped, seeded, typedDecimal } from './typed-decimal';

// numfmt defect: it takes the weekday with a remainder that cuts toward zero, so a day before day 0 has no name or
// the next day's. Each row holds the serial, the format, what numfmt answers today and the right text.
const WEEKDAYS_BEFORE_DAY_0 = [
    [-7, 'dddd', '', 'Saturday'],
    [-7, 'ddd', '', 'Sat'],
    [-7, 'aaaa', '', 'Saturday'],
    [-7, 'aaa', '', 'Sat'],
    [-8, 'dddd', '', 'Friday'],
    [-141639, 'dddd', '', 'Friday'],
    [-141639, 'ddd d mmm yyyy', ' 15 Mar 1512', 'Fri 15 Mar 1512'],
    [-0.25, 'dddd', 'Saturday', 'Friday'],
    [-0.25, 'aaa', 'Sat', 'Fri'],
    [-1.25, 'dddd', 'Friday', 'Thursday'],
] as const;

// numfmt defect: within half a second before midnight the time rounds up to 0:00:00 and the day stays. Each row
// holds the serial, the format, what numfmt answers today and the right text.
const MIDNIGHT_CARRIES = [
    [45000.999995, 'yyyy-mm-dd hh:mm:ss', '2023-03-15 00:00:00', '2023-03-16 00:00:00'],
    [45000.999995, 'dddd', 'Wednesday', 'Thursday'],
    [45657.999999, 'm/d/yyyy h:mm', '12/31/2024 0:00', '1/1/2025 0:00'],
] as const;

// numfmt defect: it writes a whole part from 1E+21 on as 1e+21, which TEXT answers with #VALUE!.
const DIGITS_OF_1E21_TODAY = null;
const DIGITS_OF_1E21_RIGHT = '1000000000000000000000';

describe('a number is shown as its 15 digit decimal', () => {
    test('a decimal that ends in 5 rounds away from zero, as ROUND and FIXED round it', () => {
        expect(valueAsText(1.005, '0.00')).toBe('1.01');
        expect(valueAsText(-1.005, '0.00')).toBe('-1.01');
        expect(valueAsText(0.145, '0.00')).toBe('0.15');
        expect(valueAsText(74.945, '#,##0.00')).toBe('74.95');
        expect(valueAsText(8.325, '0.00')).toBe('8.33');
        expect(valueAsText(1.255, '$0.00')).toBe('$1.26');
        expect(valueAsText(0.01005, '0.00%')).toBe('1.01%');
        expect(valueAsText(1.005, '0.00E+00')).toBe('1.01E+00');
        expect(valueAsText(1005, '0.00,')).toBe('1.01');
        expect(numberDisplay(1.005, '0.00')).toBe('1.01');
        expect(numberDisplay(2.675, '#,##0.00')).toBe('2.68');
    });

    test('digits past the 15th are zeros', () => {
        expect(valueAsText(Math.PI, '0.000000000000000000')).toBe('3.141592653589790000');
        expect(valueAsText(0.1 + 0.2, '0.00000000000000000')).toBe('0.30000000000000000');
        expect(numberDisplay(1 / 3, '0.00000000000000000000')).toBe('0.33333333333333300000');
    });

    test('a 5 that is shown stays as it is', () => {
        expect(valueAsText(2.5, '0.000000000000000')).toBe('2.500000000000000');
        expect(valueAsText(0.5, '0.0000000000000000')).toBe('0.5000000000000000');
        expect(valueAsText(33944.5, '0.00000000000')).toBe('33944.50000000000');
        expect(valueAsText(1.005, '0.000')).toBe('1.005');
        expect(valueAsText(1.005, '0.0')).toBe('1.0');
    });

    test('every typed decimal under a plain format is that decimal rounded half away from zero', () => {
        const random = seeded(20261112);
        for (let run = 0; run < 30000; run += 1) {
            const decimals = Math.floor(random() * 8);
            const { typed, rounded, negative } = typedDecimal(random, decimals);
            const zeros = decimals === 0 ? '' : `.${'0'.repeat(decimals)}`;
            const value = Number(typed);
            const sign = negative && Number(rounded) !== 0 ? '-' : '';
            const money = negative ? `($${grouped(rounded)})` : `$${grouped(rounded)}`;
            expect([typed, valueAsText(value, `0${zeros}`)]).toEqual([typed, sign + rounded]);
            expect([typed, numberDisplay(value, `#,##0${zeros}`)]).toEqual([typed, sign + grouped(rounded)]);
            expect([typed, valueAsText(value, `$#,##0${zeros};($#,##0${zeros})`)]).toEqual([typed, money]);
        }
    });
});

describe('numberDisplay', () => {
    test('General clears float noise', () => {
        expect(numberDisplay(0.1 + 0.2)).toBe('0.3');
        expect(numberDisplay(271.21000000000004, 'General')).toBe('271.21');
    });

    test('a mask renders the exact value', () => {
        expect(numberDisplay(0.1 + 0.2, '0.00')).toBe('0.30');
    });

    test("General shows Excel's default-width General", () => {
        expect(numberDisplay(123456789012)).toBe('1.23457E+11');
        expect(numberDisplay(1234567.891234)).toBe('1234567.891');
        expect(numberDisplay(-0.1 - 0.2)).toBe('-0.3');
        expect(numberDisplay(1e21)).toBe('1E+21');
        expect(numberDisplay(1.23456789e-7)).toBe('1.23457E-07');
    });

    test('General keeps tiny values instead of rounding them to 0', () => {
        expect(numberDisplay(1.5e-10)).toBe('1.5E-10');
    });

    test('an infinite value shows as Infinity, whatever the mask', () => {
        expect(numberDisplay(Infinity)).toBe('Infinity');
        expect(numberDisplay(-Infinity, '0.00')).toBe('-Infinity');
    });

    test('a malformed format renders General instead of throwing', () => {
        expect(numberDisplay(1234.5, '#,##0;;;;;')).toBe('1234.5');
        expect(numberDisplay('abc', '[')).toBe('abc');
    });

    test('text and booleans render through the mask', () => {
        expect(numberDisplay('abc', '0.00')).toBe('abc');
        expect(numberDisplay(true)).toBe('TRUE');
        expect(numberDisplay(undefined)).toBe('');
    });

    test('a mask renders exponent-form values through the mask', () => {
        expect(numberDisplay(1.5e-10, '0.00E+00')).toBe('1.50E-10');
        expect(numberDisplay(2e-7, '0.00%')).toBe('0.00%');
    });
});

describe('valueAsText', () => {
    test('a number under a format, rounded half away from zero', () => {
        expect(valueAsText(1234.567, '#,##0.00')).toBe('1,234.57');
        expect(valueAsText(0.5, '0')).toBe('1');
        expect(valueAsText(-0.5, '0')).toBe('-1');
        expect(valueAsText(0, '#')).toBe('');
        expect(valueAsText(1234.567, 'General')).toBe('1234.567');
    });

    test('a format that does not parse is null', () => {
        expect(valueAsText(1, 'TRUE')).toBeNull();
        expect(valueAsText(1, '"x')).toBeNull();
    });

    test("the day line is Google's: day 0 is 30 December 1899 and 1900 has no 29 February", () => {
        expect(valueAsText(0, 'yyyy-mm-dd')).toBe('1899-12-30');
        expect(valueAsText(1, 'yyyy-mm-dd')).toBe('1899-12-31');
        expect(valueAsText(60, 'yyyy-mm-dd')).toBe('1900-02-28');
        expect(valueAsText(61, 'yyyy-mm-dd')).toBe('1900-03-01');
        expect(valueAsText(2958465, 'yyyy-mm-dd')).toBe('9999-12-31');
        expect(numberDisplay(60, 'd mmm yyyy')).toBe('28 Feb 1900');
        expect(numberDisplay(0, 'dddd')).toBe('Saturday');
    });

    test('a negative number is a day before day 0', () => {
        expect(valueAsText(-1, 'yyyy-mm-dd')).toBe('1899-12-29');
        expect(valueAsText(-141639, 'yyyy-mm-dd')).toBe('1512-03-15');
        expect(valueAsText(-0.25, 'yyyy-mm-dd hh:mm')).toBe('1899-12-29 18:00');
        expect(valueAsText(-693593, 'yyyy-mm-dd')).toBe('0001-01-01');
        expect(numberDisplay(-1, 'd mmm yyyy')).toBe('29 Dec 1899');
        expect(valueAsText(-5, '0;(0);zero;@')).toBe('(5)');
    });

    test('a weekday from six days before day 0 on has its name', () => {
        expect(valueAsText(-6, 'dddd')).toBe('Sunday');
        expect(valueAsText(-1, 'ddd')).toBe('Fri');
        expect(valueAsText(-1, 'aaaa')).toBe('Friday');
    });

    test.each(WEEKDAYS_BEFORE_DAY_0)('numfmt defect: the weekday of %p under %s', (serial, fa, today, right) => {
        expect(valueAsText(serial, fa)).toBe(today);
        expect(valueAsText(serial, fa)).not.toBe(right);
    });

    test.each(MIDNIGHT_CARRIES)(
        'numfmt defect: %p under %s loses the carry at midnight',
        (serial, fa, today, right) => {
            expect(valueAsText(serial, fa)).toBe(today);
            expect(valueAsText(serial, fa)).not.toBe(right);
        },
    );

    test('numfmt defect: a number from 1E+21 on has no digits to show', () => {
        expect(valueAsText(1e21, '0')).toBe(DIGITS_OF_1E21_TODAY);
        expect(valueAsText(1e21, '0')).not.toBe(DIGITS_OF_1E21_RIGHT);
    });

    test('a text goes through the text section of the format', () => {
        expect(valueAsText('a', '0;;;"t:"@')).toBe('t:a');
        expect(valueAsText('abc', '0.00')).toBe('abc');
        expect(valueAsText('abc', '')).toBe('abc');
        expect(valueAsText('abc', '"x')).toBeNull();
    });

    test('a number whose digits cannot be written out is null', () => {
        expect(valueAsText(1e20, '0')).toBe('100000000000000000000');
        expect(valueAsText(1e300, '0')).toBeNull();
        expect(valueAsText(1e300, '0.00')).toBeNull();
        expect(valueAsText(1e300, '0.0E+00')).toBe('1.0E+300');
    });
});
