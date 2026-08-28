import { describe, expect, test } from 'bun:test';
import {
    calPostfixExpression,
    checkBracketNum,
    iscelldata,
    operatorjson,
    operatorPriority,
} from '../../engine/formula-utils';

// ─── operatorjson ───────────────────────────────────────────────────────────

describe('engine/formula-utils — operatorjson', () => {
    test('contains all comparison operators', () => {
        expect(operatorjson['==']).toBe(1);
        expect(operatorjson['!=']).toBe(1);
        expect(operatorjson['<>']).toBe(1);
        expect(operatorjson['<=']).toBe(1);
        expect(operatorjson['>=']).toBe(1);
    });

    test('contains single-char operators', () => {
        expect(operatorjson['=']).toBe(1);
        expect(operatorjson['+']).toBe(1);
        expect(operatorjson['-']).toBe(1);
        expect(operatorjson['>']).toBe(1);
        expect(operatorjson['<']).toBe(1);
        expect(operatorjson['/']).toBe(1);
        expect(operatorjson['*']).toBe(1);
        expect(operatorjson['%']).toBe(1);
        expect(operatorjson['&']).toBe(1);
        expect(operatorjson['^']).toBe(1);
    });

    test('does not contain arbitrary strings', () => {
        expect(operatorjson['abc']).toBeUndefined();
    });
});

// ─── operatorPriority ───────────────────────────────────────────────────────

describe('engine/formula-utils — operatorPriority', () => {
    test('^ has priority 0', () => {
        expect(operatorPriority['^']).toBe(0);
    });

    test('% * / have priority 1', () => {
        expect(operatorPriority['%']).toBe(1);
        expect(operatorPriority['*']).toBe(1);
        expect(operatorPriority['/']).toBe(1);
    });

    test('+ - have priority 2', () => {
        expect(operatorPriority['+']).toBe(2);
        expect(operatorPriority['-']).toBe(2);
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

    test('rejects plain text', () => {
        expect(iscelldata('hello')).toBe(false);
    });

    test('rejects empty string', () => {
        expect(iscelldata('')).toBe(false);
    });

    test('rejects reversed range B1:A1 (col reversed)', () => {
        expect(iscelldata('B1:A1')).toBe(false);
    });

    test('rejects reversed range A3:A1 (row reversed)', () => {
        expect(iscelldata('A3:A1')).toBe(false);
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

// ─── calPostfixExpression ───────────────────────────────────────────────────

describe('engine/formula-utils — calPostfixExpression', () => {
    test('returns empty string for empty array', () => {
        expect(calPostfixExpression([])).toBe('');
    });

    test('single non-operator element returns that element', () => {
        expect(calPostfixExpression(['A1'])).toBe('A1');
    });

    test('wraps comparison operator into luckysheet_compareWith', () => {
        // Postfix ["+", "A1", "B1"] means A1 + B1 in RPN (reversed)
        const result = calPostfixExpression(['+', 'A1', 'B1']);
        expect(result).toContain('luckysheet_compareWith');
        expect(result).toContain('A1');
        expect(result).toContain('B1');
        expect(result).toContain("'+'");
    });

    test('handles nested operators', () => {
        // Represents (A1 + B1) * C1 in postfix (reversed)
        const result = calPostfixExpression(['*', '+', 'A1', 'B1', 'C1']);
        expect(result).toContain('luckysheet_compareWith');
        expect(result).toContain("'*'");
        expect(result).toContain("'+'");
    });
});
