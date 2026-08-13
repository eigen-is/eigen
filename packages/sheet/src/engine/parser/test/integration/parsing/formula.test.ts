import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import Parser from '../../../parser';

describe('sheet/formula-parser/integration/parsing/formula', () => {
    let parser: Parser | null;

    beforeEach(() => {
        parser = new Parser();
    });

    afterEach(() => {
        parser = null;
    });

    test('should parse basic formulas', () => {
        expect(parser!.parse('SUM(1,2,3)')).toMatchObject({ error: null });
        expect(parser!.parse('AVERAGE(1,2,3)')).toMatchObject({ error: null });
        expect(parser!.parse('COUNT(1,2,3)')).toMatchObject({ error: null });
    });

    test('should parse nested formulas', () => {
        expect(parser!.parse('SUM(1, AVERAGE(2,3), 4)')).toMatchObject({ error: null });
        expect(parser!.parse('MAX(1, MIN(2,3), 4)')).toMatchObject({ error: null });
    });

    test('should handle formula errors gracefully', () => {
        expect(parser!.parse('INVALID()')).toMatchObject({ error: '#NAME?', result: null });
        expect(parser!.parse('SUM(')).toMatchObject({ error: '#ERROR!' });
        expect(parser!.parse('SUM(1,')).toMatchObject({ error: '#ERROR!' });
    });

    test('should parse cell references', () => {
        expect(parser!.parse('A1')).toMatchObject({ error: null });
        expect(parser!.parse('B10')).toMatchObject({ error: null });
        expect(parser!.parse('AA100')).toMatchObject({ error: null });
    });

    test('should parse ranges', () => {
        expect(parser!.parse('A1:B10')).toMatchObject({ error: null });
        expect(parser!.parse('Sheet1!A1:B10')).toMatchObject({ error: null });
    });
});
