import { describe, expect, test } from 'bun:test';
import { detectAbsolute, functionCopy, functionStrChange } from '../../engine/formula-shift';

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

describe('functionStrChange — row insert/delete', () => {
    test('shifts a standard range when a row is inserted at top', () => {
        expect(functionStrChange('A1:B3', 'add', 'row', 'lefttop', 0, 1)).toBe('A2:B4');
    });

    test('shifts a single cell when a row is inserted at top', () => {
        expect(functionStrChange('A1', 'add', 'row', 'lefttop', 0, 1)).toBe('A2');
    });

    test('shifts a row-only range when a row is inserted at top', () => {
        expect(functionStrChange('1:3', 'add', 'row', 'lefttop', 0, 1)).toBe('2:4');
    });

    test('leaves a column-only range unchanged when a row is inserted', () => {
        expect(functionStrChange('A:C', 'add', 'row', 'lefttop', 0, 1)).toBe('A:C');
    });

    test('collapses a standard range when its first row is deleted', () => {
        expect(functionStrChange('A1:B3', 'del', 'row', null, 0, 1)).toBe('A1:B2');
    });

    test('leaves a column-only range unchanged when a row is deleted', () => {
        expect(functionStrChange('A:C', 'del', 'row', null, 0, 1)).toBe('A:C');
    });
});

describe('functionStrChange — column insert/delete', () => {
    test('shifts a standard range when a column is inserted at the left', () => {
        expect(functionStrChange('A1:B3', 'add', 'col', 'lefttop', 0, 1)).toBe('B1:C3');
    });

    test('shifts a column-only range when a column is inserted at the left', () => {
        expect(functionStrChange('A:C', 'add', 'col', 'lefttop', 0, 1)).toBe('B:D');
    });

    test('leaves a row-only range unchanged when a column is inserted', () => {
        expect(functionStrChange('1:3', 'add', 'col', 'lefttop', 0, 1)).toBe('1:3');
    });

    test('leaves a row-only range unchanged when a column is deleted', () => {
        // Regression: with engine's columnLabelToIndex returning -1 (not NaN),
        // the `c1 < 0` clamp in the del branch would coerce -1 → 0 without an
        // explicit colsMissing flag, corrupting "1:3" into "A1:A3".
        expect(functionStrChange('1:3', 'del', 'col', null, 0, 1)).toBe('1:3');
    });

    test('collapses a standard range when its first column is deleted', () => {
        expect(functionStrChange('A1:B3', 'del', 'col', null, 0, 1)).toBe('A1:A3');
    });
});

describe('functionStrChange — sheet-qualified ranges', () => {
    test('preserves the sheet prefix on a standard range', () => {
        expect(functionStrChange('Sheet1!A1:B3', 'add', 'row', 'lefttop', 0, 1)).toBe('Sheet1!A2:B4');
    });

    test('preserves the sheet prefix on a row-only range', () => {
        expect(functionStrChange('Sheet1!1:3', 'add', 'row', 'lefttop', 0, 1)).toBe('Sheet1!2:4');
    });

    test('preserves the sheet prefix on a column-only range', () => {
        expect(functionStrChange('Sheet1!A:C', 'add', 'col', 'lefttop', 0, 1)).toBe('Sheet1!B:D');
    });

    test('collapses a sheet-qualified range when its first row is deleted', () => {
        expect(functionStrChange('Sheet1!A1:B3', 'del', 'row', null, 0, 1)).toBe('Sheet1!A1:B2');
    });
});

describe('functionStrChange — orientation + clamp paths', () => {
    test('rightbottom orient leaves r1 at stindex but shifts r2 past it', () => {
        // lefttop uses >=, rightbottom uses > — r1 = stindex stays in rightbottom but shifts in lefttop
        expect(functionStrChange('A1:B3', 'add', 'row', 'rightbottom', 0, 1)).toBe('A1:B4');
        expect(functionStrChange('A1:B3', 'add', 'row', 'lefttop', 0, 1)).toBe('A2:B4');
    });

    test('returns #REF! when the entire range falls inside the deletion span', () => {
        expect(functionStrChange('A1:B3', 'del', 'row', null, 0, 3)).toBe('#REF!');
        expect(functionStrChange('A1:C2', 'del', 'col', null, 0, 3)).toBe('#REF!');
    });

    test('clamps r1 to stindex when the range starts inside the deletion span', () => {
        // A2:B5 del rows 1-2: r1=1 hits the clamp (stays at stindex=1), r2=4 shifts -2 → 2
        expect(functionStrChange('A2:B5', 'del', 'row', null, 1, 2)).toBe('A2:B3');
    });

    test('returns the input unchanged on an inverted range', () => {
        // r1 > r2 (B3:A1 has r1=2, r2=0) — early return preserves the malformed input
        expect(functionStrChange('B3:A1', 'add', 'row', 'lefttop', 0, 1)).toBe('B3:A1');
        // c1 > c2 (C1:A3 has c1=2, c2=0)
        expect(functionStrChange('C1:A3', 'add', 'col', 'lefttop', 0, 1)).toBe('C1:A3');
    });
});

describe('functionStrChange — absolute refs', () => {
    test('preserves $ anchors and shifts the index on insert', () => {
        // Insert/delete shifts every ref including absolute — `$` is purely formatting
        expect(functionStrChange('$A$1', 'add', 'row', 'lefttop', 0, 1)).toBe('$A$2');
        expect(functionStrChange('$A$1:$B$3', 'add', 'row', 'lefttop', 0, 1)).toBe('$A$2:$B$4');
    });

    test('preserves mixed $ anchors through both axes', () => {
        expect(functionStrChange('$A1:B$3', 'add', 'col', 'lefttop', 0, 1)).toBe('$B1:C$3');
    });
});

describe('functionStrChange — formulas', () => {
    test('shifts refs inside arithmetic expressions', () => {
        expect(functionStrChange('A1+B1', 'add', 'row', 'lefttop', 0, 1)).toBe('A2+B2');
    });

    test('shifts refs inside SUM(range)', () => {
        expect(functionStrChange('SUM(A1:B3)', 'add', 'row', 'lefttop', 0, 1)).toBe('SUM(A2:B4)');
    });

    test('shifts refs inside SUM with a row-only range', () => {
        expect(functionStrChange('SUM(1:3)', 'add', 'row', 'lefttop', 0, 1)).toBe('SUM(2:4)');
    });

    test('does not corrupt SUM with a row-only range when columns change', () => {
        expect(functionStrChange('SUM(1:3)', 'add', 'col', 'lefttop', 0, 1)).toBe('SUM(1:3)');
    });
});

describe('functionStrChange — unary-minus predecessor scan', () => {
    // A `-` immediately after `(` is a unary sign, so `-1:3` / `-3:A10` are glued literals,
    // not recognizable refs, and must pass through unshifted — exactly what functionCopy does.
    // Both walkers now locate the unary predecessor by reading i-1 (the `(`); the former
    // decrement-then-read scan skipped it, read the function-name char, misclassified `-` as
    // binary and shifted the trailing range (`CONCAT(-1:3)` → `CONCAT(-2:4)`).
    test('treats `-` after `(` as a unary sign and leaves the glued token unshifted', () => {
        expect(functionStrChange('CONCAT(-1:3)', 'add', 'row', 'lefttop', 0, 1)).toBe('CONCAT(-1:3)');
        expect(functionStrChange('CONCAT(-3:A10)', 'add', 'row', 'lefttop', 0, 1)).toBe('CONCAT(-3:A10)');
    });

    test('functionCopy output is unchanged on the same input (already reads i-1)', () => {
        expect(functionCopy('CONCAT(-1:3)', 'down', 1)).toBe('CONCAT(-1:3)');
        expect(functionCopy('CONCAT(-3:A10)', 'down', 1)).toBe('CONCAT(-3:A10)');
    });
});
