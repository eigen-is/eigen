import { describe, expect, test } from 'bun:test';
import { detectAbsolute, functionCopy } from '../formula-shift';

describe('engine/formula-shift — functionCopy single-cell refs', () => {
    test('shifts a relative ref down', () => {
        expect(functionCopy('=A1', 'down', 1)).toBe('A2');
        expect(functionCopy('=A1', 'down', 5)).toBe('A6');
    });

    test('shifts a relative ref right', () => {
        expect(functionCopy('=A1', 'right', 1)).toBe('B1');
        expect(functionCopy('=A1', 'right', 25)).toBe('Z1');
        expect(functionCopy('=A1', 'right', 26)).toBe('AA1');
    });

    test('absolute refs do not shift', () => {
        expect(functionCopy('=$A$1', 'down', 1)).toBe('$A$1');
        expect(functionCopy('=$A1', 'right', 1)).toBe('$A1');
        expect(functionCopy('=A$1', 'down', 1)).toBe('A$1');
    });

    test('sheet-qualified refs preserve the prefix', () => {
        expect(functionCopy('=Sheet1!A1', 'down', 1)).toBe('Sheet1!A2');
        expect(functionCopy('=Sheet1!$A$1', 'down', 1)).toBe('Sheet1!$A$1');
    });

    test('strips a single leading equals before processing', () => {
        expect(functionCopy('=A1', 'down', 1)).toBe('A2');
        expect(functionCopy('A1', 'down', 1)).toBe('A2');
    });
});

describe('engine/formula-shift — functionCopy ranges', () => {
    test('shifts a relative range', () => {
        expect(functionCopy('=A1:B3', 'down', 1)).toBe('A2:B4');
        expect(functionCopy('=A1:B3', 'right', 1)).toBe('B1:C3');
    });

    test('preserves $-anchored leg in mixed range', () => {
        expect(functionCopy('=$A1:B$3', 'down', 1)).toBe('$A2:B$3');
    });

    test('column-only range shifts cols only', () => {
        expect(functionCopy('=A:C', 'right', 1)).toBe('B:D');
        expect(functionCopy('=A:C', 'down', 1)).toBe('A:C');
    });

    test('row-only range shifts rows only', () => {
        // Regression: this returned `#REF!` and `A1:A3` respectively before the
        // fix in formula-shift.ts. The original state-side `functionCopy` (from
        // formula-range.ts) used `columnCharToIndex` which returns NaN for empty
        // input — the check `Number.isNaN(col[0]) && Number.isNaN(col[1])` then
        // routed row-only ranges to the cols-missing branch. The engine port
        // switched to `columnLabelToIndex` (returns -1) without updating the
        // missing-axis detection.
        expect(functionCopy('=1:3', 'down', 1)).toBe('2:4');
        expect(functionCopy('=1:3', 'right', 1)).toBe('1:3');
    });

    test('range going negative produces #REF!', () => {
        expect(functionCopy('=A1:B3', 'up', 5)).toBe('#REF!');
        expect(functionCopy('=A1:B3', 'left', 5)).toBe('#REF!');
        expect(functionCopy('=1:3', 'up', 5)).toBe('#REF!');
        expect(functionCopy('=B:C', 'left', 5)).toBe('#REF!');
        expect(functionCopy('=A:C', 'left', 1)).toBe('#REF!');
    });

    test('sheet-qualified range preserves prefix on row-only and col-only', () => {
        expect(functionCopy('=Sheet1!A1:B3', 'down', 1)).toBe('Sheet1!A2:B4');
        expect(functionCopy('=Sheet1!1:3', 'down', 1)).toBe('Sheet1!2:4');
        expect(functionCopy('=Sheet1!A:C', 'right', 1)).toBe('Sheet1!B:D');
    });
});

describe('engine/formula-shift — functionCopy formulas', () => {
    test('shifts refs inside arithmetic', () => {
        expect(functionCopy('=A1+B1', 'down', 1)).toBe('A2+B2');
        expect(functionCopy('=A1*2', 'down', 1)).toBe('A2*2');
    });

    test('shifts refs inside function calls', () => {
        expect(functionCopy('=SUM(A1,B1,C1)', 'down', 1)).toBe('SUM(A2,B2,C2)');
        expect(functionCopy('=SUM(A1:A3)', 'down', 1)).toBe('SUM(A2:A4)');
        // Note: leading whitespace inside arguments is discarded by `str.trim()` at the
        // recursion boundary — same behaviour as the original state-side functionCopy.
        expect(functionCopy('=AND(A1>0, B1>0)', 'down', 1)).toBe('AND(A2>0,B2>0)');
    });

    test('shifts row-only range inside SUM', () => {
        expect(functionCopy('=SUM(1:3)', 'down', 1)).toBe('SUM(2:4)');
    });

    test('handles unary minus', () => {
        expect(functionCopy('=-A1', 'down', 1)).toBe('-A2');
    });

    test('preserves quoted strings', () => {
        expect(functionCopy('=A1&"x"', 'down', 1)).toBe('A2&"x"');
    });

    test('step=0 is a no-op', () => {
        expect(functionCopy('=A1+B1', 'down', 0)).toBe('A1+B1');
        expect(functionCopy('=A1:B3', 'down', 0)).toBe('A1:B3');
    });
});

describe('engine/formula-shift — detectAbsolute', () => {
    test('detects no $ for plain ref', () => {
        expect(detectAbsolute('A1')).toEqual([false, false]);
    });

    test('detects $ for fully absolute', () => {
        expect(detectAbsolute('$A$1')).toEqual([true, true]);
    });

    test('detects $ for mixed', () => {
        expect(detectAbsolute('$A1')).toEqual([false, true]);
        expect(detectAbsolute('A$1')).toEqual([true, false]);
    });

    test('returns false for the missing-half slot in col-only or row-only refs', () => {
        // `A` (col-only) — no row, so the row-frozen slot must be false.
        expect(detectAbsolute('A')[0]).toBe(false);
        // `1` (row-only) — no col, so the col-frozen slot must be false.
        expect(detectAbsolute('1')[1]).toBe(false);
    });
});
