import { describe, expect, test } from 'bun:test';
import { numberDisplay, numberFormatError } from '../../format';
import { valueAsText } from '../../format/number-display';
import { grouped, seeded, typedDecimal } from './typed-decimal';

// A day before day 0 has its own weekday, with or without a time: 15 March 1512 was a Friday, and -0.25 is the
// evening of Friday 29 December 1899.
const WEEKDAYS_BEFORE_DAY_0 = [
    [-7, 'dddd', 'Saturday'],
    [-7, 'ddd', 'Sat'],
    [-7, 'aaaa', 'Saturday'],
    [-7, 'aaa', 'Sat'],
    [-8, 'dddd', 'Friday'],
    [-141639, 'dddd', 'Friday'],
    [-141639, 'ddd d mmm yyyy', 'Fri 15 Mar 1512'],
    [-0.25, 'dddd', 'Friday'],
    [-0.25, 'aaa', 'Fri'],
    [-1.25, 'dddd', 'Thursday'],
] as const;

// A time that rounds up to midnight at the last unit shown is midnight of the next day. Excel's rows.
const MIDNIGHT_CARRIES = [
    [45000.999995, 'yyyy-mm-dd hh:mm:ss', '2023-03-16 00:00:00'],
    [45657.999999, 'm/d/yyyy h:mm', '1/1/2025 0:00'],
    [45000.9999999, 'yyyy-mm-dd hh:mm:ss.0', '2023-03-16 00:00:00.0'],
    [45000.999999, 'yyyy-mm-dd hh:mm:ss.00', '2023-03-15 23:59:59.91'],
    [45000.99999, 'yyyy-mm-dd hh:mm', '2023-03-15 23:59'],
    [45000.99999, 'yyyy-mm-dd hh', '2023-03-15 23'],
    [45000.99999, 'yyyy-mm-dd', '2023-03-15'],
    [0.999995, 'h:mm:ss AM/PM', '12:00:00 AM'],
] as const;

// A decimal that ends in a 5 is rounded as that decimal, away from zero, though the double under it can lie just
// under the half. Excel's rows.
const TIES = [
    [1.005, '0.00', '1.01'],
    [-1.005, '0.00', '-1.01'],
    [74.945, '#,##0.00', '74.95'],
    [260.405, '0.00', '260.41'],
    [0.01005, '0.00%', '1.01%'],
    [1.005, '0.00E+00', '1.01E+00'],
    [1005, '0.00,', '1.01'],
    [0.1 * 2.85, '0.00', '0.29'],
    [1.5 * 0.67, '0.00', '1.01'],
] as const;

// A fraction that rounds to a whole is that whole, with blanks where the fraction stood. Excel's rows.
const FRACTIONS = [
    [5.9, '# ?/?', '6    '],
    [5.99, '# ??/??', '6      '],
    [0.99, '# ?/?', '1    '],
    [-5.9, '# ?/?', '-6    '],
    [5.5, '# ?/?', '5 1/2'],
    [0.96, '?/?', '1/1'],
    [5.96, '# ?/8', '6    '],
] as const;

// numfmt defects, each with what it answers today and Excel's row. A date alone does not carry a time that rounds
// up to midnight, and half a second whose double lies under the half rounds up.
const NUMFMT_DEFECTS = [
    [45000.999995, 'dddd', 'Wednesday', 'Thursday'],
    [0.5 + 0.5 / 86400, 'hh:mm:ss', '12:00:01', '12:00:00'],
] as const;

describe('a number is shown as its 15 digit decimal', () => {
    test.each(TIES)('%p under %s rounds its half away from zero', (value, fa, right) => {
        expect(valueAsText(value, fa)).toBe(right);
        expect(numberDisplay(value, fa)).toBe(right);
    });

    test.each(FRACTIONS)('%p under %s is the nearest fraction', (value, fa, right) => {
        expect(valueAsText(value, fa)).toBe(right);
    });

    test('a number under 1E-6 has its digits', () => {
        expect(valueAsText(1 / 3000000, '0.0000000000')).toBe('0.0000003333');
        expect(valueAsText(0.000000123456, '0.000000000')).toBe('0.000000123');
        expect(valueAsText(1e-10, '0.00000000000000')).toBe('0.00000000010000');
        expect(numberDisplay(1e-7, '0.0000000')).toBe('0.0000001');
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

    test('every typed decimal is that decimal rounded, a half away from zero', () => {
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

    test.each(WEEKDAYS_BEFORE_DAY_0)('the weekday of %p under %s', (serial, fa, right) => {
        expect(valueAsText(serial, fa)).toBe(right);
    });

    test.each(MIDNIGHT_CARRIES)('%p under %s at midnight', (serial, fa, right) => {
        expect(valueAsText(serial, fa)).toBe(right);
    });

    test('half a second rounds up to the next second', () => {
        expect(valueAsText(41787 + (10 * 3600 + 32 * 60 + 11.5) / 86400, 'hh:mm:ss')).toBe('10:32:12');
    });

    test.each(NUMFMT_DEFECTS)('numfmt defect: %p under %s', (value, fa, today, right) => {
        expect(valueAsText(value, fa)).toBe(today);
        expect(valueAsText(value, fa)).not.toBe(right);
    });

    test('a number from 1E+21 on has its 15 digits and zeros', () => {
        expect(valueAsText(1e21, '0')).toBe('1000000000000000000000');
        expect(valueAsText(1e21, '#,##0')).toBe('1,000,000,000,000,000,000,000');
        expect(valueAsText(1e21, '0.00')).toBe('1000000000000000000000.00');
        expect(valueAsText(1.23456789012345e30, '0')).toBe('1234567890123450000000000000000');
        expect(valueAsText(1e300, '0')).toBe(`1${'0'.repeat(300)}`);
        expect(valueAsText(1e300, '0.0E+00')).toBe('1.0E+300');
    });

    test('a text goes through the text section of the format', () => {
        expect(valueAsText('a', '0;;;"t:"@')).toBe('t:a');
        expect(valueAsText('abc', '0.00')).toBe('abc');
        expect(valueAsText('abc', '')).toBe('abc');
        expect(valueAsText('abc', '"x')).toBeNull();
    });

    test('a number whose digits numfmt cannot write out is null', () => {
        expect(valueAsText(1e20, '# ?/?')).toBe('100000000000000000000    ');
        expect(valueAsText(1e22, '# ?/?')).toBeNull();
    });
});

describe('numberFormatError', () => {
    test('a format numfmt reads has none', () => {
        expect(numberFormatError(1234.5, '#,##0.00')).toBeNull();
        expect(numberFormatError('a', '@')).toBeNull();
    });

    test('a format numfmt refuses gives its reason', () => {
        expect(numberFormatError(1234.5, '#,##0.00"')).toBe('Illegal character: #,##0.00"');
        expect(numberFormatError(1, 'dd.,MM/yyyy')).toBe('Illegal format');
    });
});
