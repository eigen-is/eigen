import { describe, expect, test } from 'bun:test';
import { numberDisplay } from '../../charts/number-display';

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
