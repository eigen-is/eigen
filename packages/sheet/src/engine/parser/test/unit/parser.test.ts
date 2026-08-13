import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import Parser from '../../parser';

describe('sheet/formula-parser/parser', () => {
    let parser: Parser | null;

    beforeEach(() => {
        parser = new Parser();
    });

    afterEach(() => {
        parser = null;
    });

    describe('.parse()', () => {
        test('should be defined', () => {
            expect(parser!.parse).toBeInstanceOf(Function);
        });

        test('should return error when input is not a string', () => {
            // @ts-expect-error - runtime robustness: non-string inputs should error, not crash
            expect(parser!.parse(123)).toMatchObject({ error: '#ERROR!', result: null });
            // @ts-expect-error - runtime robustness: non-string inputs should error, not crash
            expect(parser!.parse(null)).toMatchObject({ error: '#ERROR!', result: null });
            // @ts-expect-error - runtime robustness: non-string inputs should error, not crash
            expect(parser!.parse(undefined)).toMatchObject({ error: '#ERROR!', result: null });
            // @ts-expect-error - runtime robustness: non-string inputs should error, not crash
            expect(parser!.parse({})).toMatchObject({ error: '#ERROR!', result: null });
        });

        test('should return empty string when input is empty', () => {
            expect(parser!.parse('')).toMatchObject({ error: null, result: '' });
        });

        test('should return parsed result when input is not a formula', () => {
            expect(parser!.parse('123')).toMatchObject({ error: null, result: 123 });
            expect(parser!.parse('123.45')).toMatchObject({ error: null, result: 123.45 });
        });
    });
});
