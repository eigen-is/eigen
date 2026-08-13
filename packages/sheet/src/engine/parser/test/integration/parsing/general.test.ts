import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import Parser from '../../../parser';

describe('sheet/formula-parser/integration/parsing/general', () => {
    let parser: Parser | null;

    beforeEach(() => {
        parser = new Parser();
    });

    afterEach(() => {
        parser = null;
    });

    test('should parse an empty string as it is', () => {
        expect(parser!.parse('')).toMatchObject({ error: null, result: '' });
    });

    test('should not parse an number type data', () => {
        // @ts-expect-error - runtime robustness: non-string inputs should error, not crash
        expect(parser!.parse(200)).toMatchObject({ error: '#ERROR!', result: null });
        // @ts-expect-error - runtime robustness: non-string inputs should error, not crash
        expect(parser!.parse(20.1)).toMatchObject({ error: '#ERROR!', result: null });
    });

    test('should not parse an object type data', () => {
        // @ts-expect-error - runtime robustness: non-string inputs should error, not crash
        expect(parser!.parse({})).toMatchObject({ error: '#ERROR!', result: null });
        // @ts-expect-error - runtime robustness: non-string inputs should error, not crash
        expect(parser!.parse([])).toMatchObject({ error: '#ERROR!', result: null });
    });

    test('should not parse a null type data', () => {
        // @ts-expect-error - runtime robustness: non-string inputs should error, not crash
        expect(parser!.parse(null)).toMatchObject({ error: '#ERROR!', result: null });
    });

    test('should not parse an undefined type data', () => {
        // @ts-expect-error - runtime robustness: non-string inputs should error, not crash
        expect(parser!.parse(undefined)).toMatchObject({ error: '#ERROR!', result: null });
    });

    test('should not parse a boolean type data', () => {
        // @ts-expect-error - runtime robustness: non-string inputs should error, not crash
        expect(parser!.parse(true)).toMatchObject({ error: '#ERROR!', result: null });
        // @ts-expect-error - runtime robustness: non-string inputs should error, not crash
        expect(parser!.parse(false)).toMatchObject({ error: '#ERROR!', result: null });
    });

    test('should handle function type data', () => {
        const fn = () => {};
        // @ts-expect-error - runtime robustness: non-string inputs should error, not crash
        expect(parser!.parse(fn)).toMatchObject({ error: '#ERROR!', result: null });
    });

    test('should not parse a symbol type data', () => {
        const sym = Symbol('test');
        // @ts-expect-error - runtime robustness: non-string inputs should error, not crash
        expect(parser!.parse(sym)).toMatchObject({ error: '#ERROR!', result: null });
    });

    test('should not parse a bigint type data', () => {
        // @ts-expect-error - runtime robustness: non-string inputs should error, not crash
        expect(parser!.parse(BigInt(123))).toMatchObject({ error: '#ERROR!', result: null });
    });
});
