import { describe, expect, test } from 'bun:test';
import { checkBracketNum, formulaOperators, iscelldata } from '../../engine/formula-utils';

// ─── formulaOperators ───────────────────────────────────────────────────────

describe('engine/formula-utils — formulaOperators', () => {
    test("holds Excel's operators and nothing else", () => {
        expect([...formulaOperators].sort()).toEqual(
            ['<>', '<=', '>=', '=', '+', '-', '>', '<', '/', '*', '%', '&', '^'].sort(),
        );
    });

    test("leaves out JavaScript's == and !=, which Excel has no operator for", () => {
        expect(formulaOperators.has('==')).toBe(false);
        expect(formulaOperators.has('!=')).toBe(false);
    });
});

// ─── iscelldata ─────────────────────────────────────────────────────────────

describe('engine/formula-utils — iscelldata', () => {
    test('recognizes simple cell reference A1', () => {
        expect(iscelldata('A1')).toBe(true);
    });

    test('recognizes multi-letter column Z99', () => {
        expect(iscelldata('Z99')).toBe(true);
    });

    test('recognizes absolute column $A1', () => {
        expect(iscelldata('$A1')).toBe(true);
    });

    test('recognizes absolute row A$1', () => {
        expect(iscelldata('A$1')).toBe(true);
    });

    test('recognizes fully absolute $A$1', () => {
        expect(iscelldata('$A$1')).toBe(true);
    });

    test('recognizes multi-letter column AA100', () => {
        expect(iscelldata('AA100')).toBe(true);
    });

    test('recognizes range A1:B3', () => {
        expect(iscelldata('A1:B3')).toBe(true);
    });

    test('recognizes column-only range A:C', () => {
        expect(iscelldata('A:C')).toBe(true);
    });

    test('recognizes range with absolute refs $A$1:$B$3', () => {
        expect(iscelldata('$A$1:$B$3')).toBe(true);
    });

    test('recognizes row-only range 1:3', () => {
        expect(iscelldata('1:3')).toBe(true);
    });

    test('recognizes absolute row-only range $1:$3', () => {
        expect(iscelldata('$1:$3')).toBe(true);
    });

    test('recognizes sheet-qualified reference Sheet1!A1', () => {
        expect(iscelldata('Sheet1!A1')).toBe(true);
    });

    test('recognizes sheet-qualified range Sheet1!A1:B3', () => {
        expect(iscelldata('Sheet1!A1:B3')).toBe(true);
    });

    test('a quoted sheet name may hold a `!`', () => {
        expect(iscelldata("'a!b'!A1")).toBe(true);
        expect(iscelldata("'a!b'!Name")).toBe(false);
    });

    test('rejects plain text', () => {
        expect(iscelldata('hello')).toBe(false);
    });

    test('rejects empty string', () => {
        expect(iscelldata('')).toBe(false);
    });

    // Excel reads a reversed range as its sorted twin, so it is a ref the shifters must see.
    test('accepts reversed ranges', () => {
        expect(iscelldata('B1:A1')).toBe(true);
        expect(iscelldata('A3:A1')).toBe(true);
        expect(iscelldata('A$3:A1')).toBe(true);
        expect(iscelldata('C:A')).toBe(true);
        expect(iscelldata('3:1')).toBe(true);
    });

    test('rejects number-only string', () => {
        expect(iscelldata('123')).toBe(false);
    });
});

// ─── checkBracketNum ────────────────────────────────────────────────────────

describe('engine/formula-utils — checkBracketNum', () => {
    test('balanced simple expression', () => {
        expect(checkBracketNum('SUM(A1:A3)')).toBe(true);
    });

    test('balanced nested expression', () => {
        expect(checkBracketNum('SUM(A1, MAX(B1, C1))')).toBe(true);
    });

    test('unbalanced — missing close', () => {
        expect(checkBracketNum('SUM(A1:A3')).toBe(false);
    });

    test('unbalanced — extra close', () => {
        expect(checkBracketNum('SUM(A1:A3))')).toBe(false);
    });

    test('brackets inside quotes are excluded', () => {
        expect(checkBracketNum('CONCAT("(", A1)')).toBe(true);
    });

    test('no brackets at all', () => {
        expect(checkBracketNum('A1+B1')).toBe(true);
    });
});
