import { describe, expect, test } from 'bun:test';
import { numberDisplay } from '../../format';
import { numberAsText } from '../../format/number-display';

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

describe('numberAsText', () => {
    test('a number under a format, rounded half away from zero', () => {
        expect(numberAsText(1234.567, '#,##0.00')).toBe('1,234.57');
        expect(numberAsText(0.5, '0')).toBe('1');
        expect(numberAsText(-0.5, '0')).toBe('-1');
        expect(numberAsText(0, '#')).toBe('');
        expect(numberAsText(1234.567, 'General')).toBe('1234.567');
    });

    test('a format that does not parse is null', () => {
        expect(numberAsText(1, 'TRUE')).toBeNull();
        expect(numberAsText(1, '"x')).toBeNull();
    });

    test("the day line is Google's: day 0 is 30 December 1899 and 1900 has no 29 February", () => {
        expect(numberAsText(0, 'yyyy-mm-dd')).toBe('1899-12-30');
        expect(numberAsText(1, 'yyyy-mm-dd')).toBe('1899-12-31');
        expect(numberAsText(60, 'yyyy-mm-dd')).toBe('1900-02-28');
        expect(numberAsText(61, 'yyyy-mm-dd')).toBe('1900-03-01');
        expect(numberAsText(2958465, 'yyyy-mm-dd')).toBe('9999-12-31');
        expect(numberDisplay(60, 'd mmm yyyy')).toBe('28 Feb 1900');
        expect(numberDisplay(0, 'dddd')).toBe('Saturday');
    });

    test('a negative number is a day before day 0', () => {
        expect(numberAsText(-1, 'yyyy-mm-dd')).toBe('1899-12-29');
        expect(numberAsText(-141639, 'yyyy-mm-dd')).toBe('1512-03-15');
        expect(numberAsText(-0.25, 'yyyy-mm-dd hh:mm')).toBe('1899-12-29 18:00');
        expect(numberAsText(-693593, 'yyyy-mm-dd')).toBe('0001-01-01');
        expect(numberDisplay(-1, 'd mmm yyyy')).toBe('29 Dec 1899');
        expect(numberAsText(-5, '0;(0);zero;@')).toBe('(5)');
    });

    test('numfmt defect: a weekday before day 0 is empty or a day late', () => {
        expect(numberAsText(-6, 'dddd')).toBe('Sunday');
        expect(numberAsText(-7, 'dddd')).toBe('');
        expect(numberAsText(-141639, 'ddd')).toBe('');
        expect(numberAsText(-1.25, 'dddd')).toBe('Friday');
    });

    test('a number whose digits cannot be written out is null', () => {
        expect(numberAsText(1e20, '0')).toBe('100000000000000000000');
        expect(numberAsText(1e300, '0')).toBeNull();
        expect(numberAsText(1e300, '0.00')).toBeNull();
        expect(numberAsText(1e300, '0.0E+00')).toBe('1.0E+300');
    });
});
