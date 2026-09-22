import { describe, expect, test } from 'bun:test';
import { is_date, numberDisplay, parseCellInput, update, valueShowEs } from '../../engine/format';
import type { CellMatrix } from '../../engine/types';

describe('engine/format — date serials', () => {
    test('converts a date string to an Excel serial number', () => {
        const [m, ct, v] = parseCellInput('2023-01-01');
        expect(m).toBe('2023-01-01');
        expect(ct.t).toBe('d');
        expect(v).toBe(44927);
    });

    test('serial for 1900-01-01 is 1', () => {
        const [, ct, v] = parseCellInput('1900-01-01');
        expect(ct.t).toBe('d');
        expect(v).toBe(1);
    });
});

describe('engine/format — parseCellInput', () => {
    test('infers plain integer as numeric General format', () => {
        const result = parseCellInput(42);
        expect(result).not.toBeNull();
        const [m, ct, v] = result!;
        expect(m).toBe('42');
        expect(ct.fa).toBe('General');
        expect(ct.t).toBe('n');
        expect(v).toBe(42);
    });

    test('infers decimal number with correct fixed-point format', () => {
        const result = parseCellInput(3.14);
        expect(result).not.toBeNull();
        const [, ct, v] = result!;
        expect(ct.fa).toBe('0.00');
        expect(ct.t).toBe('n');
        expect(typeof v).toBe('number');
    });

    test('infers monetary string (comma-formatted) as numeric', () => {
        const result = parseCellInput('1,234.56');
        expect(result).not.toBeNull();
        const [m, ct, v] = result!;
        expect(m).toBe('1,234.56');
        expect(ct.t).toBe('n');
        expect(ct.fa).toContain('#,##0');
        expect(v).toBe(1234.56);
    });

    test('keeps the decimals of a one-group monetary string', () => {
        expect(parseCellInput('1,000.50')).toEqual(['1,000.50', { fa: '#,##0.00', t: 'n' }, 1000.5]);
        expect(parseCellInput('-1,000.50')).toEqual(['-1,000.50', { fa: '#,##0.00', t: 'n' }, -1000.5]);
        expect(parseCellInput('1,000.5')).toEqual(['1,000.5', { fa: '#,##0.0', t: 'n' }, 1000.5]);
    });

    test('two-group monetary strings keep their decimals as well', () => {
        expect(parseCellInput('1,000,000.50')).toEqual(['1,000,000.50', { fa: '#,##0.00', t: 'n' }, 1000000.5]);
    });

    test('monetary string without decimals stays an integer', () => {
        expect(parseCellInput('1,000')).toEqual(['1,000', { fa: '#,##0', t: 'n' }, 1000]);
        expect(parseCellInput('12,345')).toEqual(['12,345', { fa: '#,##0', t: 'n' }, 12345]);
    });

    test('a thousands group followed by junk stays text', () => {
        const result = parseCellInput('1,000x50');
        expect(result).not.toBeNull();
        const [m, ct, v] = result!;
        expect(m).toBe('1,000x50');
        expect(ct.t).toBe('g');
        expect(v).toBe('1,000x50');
    });

    test('Infinity stays text — Excel has no infinite number literal', () => {
        const result = parseCellInput('Infinity');
        expect(result).not.toBeNull();
        const [m, ct, v] = result!;
        expect(m).toBe('Infinity');
        expect(ct.t).toBe('g');
        expect(v).toBe('Infinity');
    });

    test('a hex literal stays text instead of being parsed down to its prefix', () => {
        const result = parseCellInput('0x10');
        expect(result).not.toBeNull();
        const [m, ct, v] = result!;
        expect(m).toBe('0x10');
        expect(ct.t).toBe('g');
        expect(v).toBe('0x10');
    });

    test('infers TRUE boolean string', () => {
        const result = parseCellInput('TRUE');
        expect(result).not.toBeNull();
        const [m, ct, v] = result!;
        expect(m).toBe('TRUE');
        expect(ct.t).toBe('b');
        expect(v).toBe(true);
    });

    test('infers FALSE boolean string', () => {
        const result = parseCellInput('FALSE');
        expect(result).not.toBeNull();
        const [m, ct, v] = result!;
        expect(m).toBe('FALSE');
        expect(ct.t).toBe('b');
        expect(v).toBe(false);
    });

    test('infers string prefixed with apostrophe as text', () => {
        const result = parseCellInput("'hello");
        expect(result).not.toBeNull();
        const [m, ct] = result!;
        expect(m).toBe('hello');
        expect(ct.fa).toBe('@');
        expect(ct.t).toBe('s');
    });

    test('infers percentage string', () => {
        const result = parseCellInput('25%');
        expect(result).not.toBeNull();
        const [, ct] = result!;
        expect(ct.t).toBe('n');
        expect(ct.fa).toContain('%');
    });

    test('infers error value as error type', () => {
        const result = parseCellInput('#DIV/0!');
        expect(result).not.toBeNull();
        const [m, ct] = result!;
        expect(m).toBe('#DIV/0!');
        expect(ct.t).toBe('e');
    });

    test('plain text string becomes general/string type', () => {
        const result = parseCellInput('hello world');
        expect(result).not.toBeNull();
        const [m, ct] = result!;
        expect(m).toBe('hello world');
        // Non-date, non-number text → general "g" type
        expect(ct.t).toBe('g');
    });
});

describe('engine/format — update', () => {
    test('formats a number using the given format string', () => {
        expect(update('0.00', 1.5)).toBe('1.50');
        expect(update('#,##0', 1234567)).toBe('1,234,567');
        expect(update('General', 42)).toBe('42');
    });

    test('formats a percentage', () => {
        expect(update('0%', 0.25)).toBe('25%');
    });
});

describe('engine/format — numberDisplay', () => {
    test('General clears float noise', () => {
        expect(numberDisplay(0.1 + 0.2)).toBe('0.3');
        expect(numberDisplay(271.21000000000004, 'General')).toBe('271.21');
    });

    test('a mask renders the rounded value', () => {
        expect(numberDisplay(0.1 + 0.2, '0.00')).toBe('0.30');
    });

    test('infinite and exponent-form values', () => {
        expect(numberDisplay(Infinity)).toBe('Infinity');
        expect(numberDisplay(1e21)).toBe('1e+21');
        expect(numberDisplay(1.23456789e-7)).toBe('1.23457e-7');
    });

    test('a mask renders exponent-form values through the mask', () => {
        expect(numberDisplay(1.5e-10, '0.00E+00')).toBe(update('0.00E+00', 1.5e-10));
        expect(numberDisplay(2e-7, '0.00%')).toBe('0.00%');
    });
});

describe('engine/format — is_date', () => {
    test('detects date format strings', () => {
        expect(is_date('yyyy-MM-dd')).toBe(true);
        expect(is_date('m/d/yy')).toBe(true);
        expect(is_date('hh:mm:ss')).toBe(true);
    });

    test('returns false for non-date format strings', () => {
        expect(is_date('General')).toBe(false);
        expect(is_date('0.00')).toBe(false);
        expect(is_date('#,##0')).toBe(false);
    });

    // Numeric input is Excel's built-in format code id (e.g. 14 = m/d/yyyy).
    // Callers resolve numeric codes via explicit id checks (see state/modules/toolbar.ts).
    test('returns false for numeric format codes', () => {
        expect(is_date(14)).toBe(false);
        expect(is_date(0)).toBe(false);
    });
});

describe('engine/format — valueShowEs', () => {
    test('returns the v value when m is null', () => {
        const d: CellMatrix = [[{ v: 42, ct: { t: 'n', fa: 'General' } }]];
        expect(valueShowEs(0, 0, d)).toBe(42);
    });

    test('returns v value when m is numeric (not a percentage)', () => {
        const d: CellMatrix = [[{ v: 100, m: '100', ct: { t: 'n', fa: 'General' } }]];
        expect(valueShowEs(0, 0, d)).toBe(100);
    });

    test('returns m value when cell is a date type', () => {
        // For date cells the formatted display string (m) should be returned
        const d: CellMatrix = [[{ v: 44927, m: '2023-01-01', ct: { t: 'd', fa: 'yyyy-MM-dd' } }]];
        expect(valueShowEs(0, 0, d)).toBe('2023-01-01');
    });

    test('returns m value when cell is a boolean type', () => {
        const d: CellMatrix = [[{ v: true, m: 'TRUE', ct: { t: 'b', fa: 'General' } }]];
        expect(valueShowEs(0, 0, d)).toBe('TRUE');
    });

    test('returns null for empty cell', () => {
        const d: CellMatrix = [[null]];
        expect(valueShowEs(0, 0, d)).toBeNull();
    });
});
