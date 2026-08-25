import { afterEach, beforeEach, describe, expect, it, xit } from 'bun:test';
import Parser from '../../../../../../engine/parser/parser';

describe('.parse() miscellaneous formulas', () => {
    let parser: Parser | null;

    beforeEach(() => {
        parser = new Parser();
    });
    afterEach(() => {
        parser = null;
    });

    it('UNIQUE', () => {
        expect(parser!.parse('UNIQUE()')).toMatchObject({ error: null, result: [] });
        expect(parser!.parse('UNIQUE(1, 2, 3, 4, 2, 3)')).toMatchObject({
            error: null,
            result: [1, 2, 3, 4],
        });
        expect(parser!.parse('UNIQUE("foo", "bar", "foo")')).toMatchObject({
            error: null,
            result: ['foo', 'bar'],
        });
    });

    xit('ARGS2ARRAY', () => {
        // ARGS2ARRAY is not available in @formulajs/formulajs
        expect(parser!.parse('ARGS2ARRAY()')).toMatchObject({
            error: '#NAME?',
            result: null,
        });
    });

    xit('FLATTEN', () => {
        // FLATTEN is not available in @formulajs/formulajs
        expect(parser!.parse('FLATTEN(A1:B3)')).toMatchObject({
            error: '#NAME?',
            result: null,
        });
    });

    xit('JOIN', () => {
        // JOIN is not available in @formulajs/formulajs
        expect(parser!.parse('JOIN(A1:B3)')).toMatchObject({
            error: '#NAME?',
            result: null,
        });
    });

    xit('NUMBERS', () => {
        // NUMBERS is not available in @formulajs/formulajs
        expect(parser!.parse('NUMBERS()')).toMatchObject({
            error: '#NAME?',
            result: null,
        });
    });

    xit('REFERENCE', () => {
        // REFERENCE is not available in @formulajs/formulajs
        expect(parser!.parse('REFERENCE()')).toMatchObject({
            error: '#NAME?',
            result: null,
        });
    });
});
