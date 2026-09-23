import { describe, expect, test } from 'bun:test';
import evaluateByOperator from '../../../../../engine/parser/evaluate-by-operator/evaluate-by-operator';

describe('evaluate-by-operator dispatch', () => {
    test('arithmetic operators propagate Error operands instead of silently coercing', () => {
        const err = new Error('#VALUE!');
        // toNumber returns undefined for Error → silent `?? 0` would yield 1.
        // Propagating the Error keeps the failure visible to the next operator.
        expect(evaluateByOperator('+', [err, 1])).toBe(err);
        expect(evaluateByOperator('-', [err, 1])).toBe(err);
        expect(evaluateByOperator('*', [err, 2])).toBe(err);
        expect(evaluateByOperator('/', [err, 2])).toBe(err);
        expect(evaluateByOperator('^', [err, 2])).toBe(err);
        expect(evaluateByOperator('&', [err, 'x'])).toBe(err);
    });

    test('arithmetic operators convert thrown errors to returned formulajs Errors', () => {
        // `"" + 1` throws #VALUE! inside add.ts; the dispatcher must return the
        // Error so the grammar can keep reducing (an outer IF may discard it) —
        // as formulajs's own singleton, so IFERROR/ISERROR recognize it by identity.
        const result = evaluateByOperator('+', ['', 1]);
        expect(result).toBeInstanceOf(Error);
        expect((result as Error).message).toBe('#VALUE!');
        expect(evaluateByOperator('IFERROR', [result, 'fallback'])).toBe('fallback');
    });

    test('comparison operators propagate Error operands, the left one first', () => {
        const err = new Error('#VALUE!');
        const other = new Error('#DIV/0!');
        for (const op of ['=', '<>', '<', '>', '<=', '>=']) {
            expect(evaluateByOperator(op, [err, 5])).toBe(err);
            expect(evaluateByOperator(op, [5, err])).toBe(err);
            expect(evaluateByOperator(op, [err, other])).toBe(err);
        }
    });

    test('function-name operator passes Error operands through to formulajs', () => {
        // formulajs IF inspects `test` for Error and propagates; otherwise it
        // returns the chosen branch verbatim. The dispatcher must not filter
        // Error operands ahead of the call or short-circuiting breaks.
        const err = new Error('#VALUE!');
        // IF(FALSE, Error, "ok") → "ok" (untaken branch's Error is discarded).
        expect(evaluateByOperator('IF', [false, err, 'ok'])).toBe('ok');
        // IF(TRUE, Error, "ok") → propagates the Error from the taken branch.
        expect(evaluateByOperator('IF', [true, err, 'ok'])).toBe(err);
        // IF(Error, ...) → formulajs returns the Error from the test arg.
        expect(evaluateByOperator('IF', [err, 1, 2])).toBe(err);
    });
});
