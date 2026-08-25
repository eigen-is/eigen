import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import Parser from '../../../../../engine/parser/parser';
import type { FormulaArg } from '../../../../../engine/types';

describe('.parse() custom function', () => {
    let parser: Parser | null;

    beforeEach(() => {
        parser = new Parser();
    });
    afterEach(() => {
        parser = null;
    });

    test('should evaluate custom functions', () => {
        expect(parser!.parse('foo()')).toMatchObject({
            error: '#NAME?',
            result: null,
        });

        parser!.setFunction('ADD_5', (params: FormulaArg[]) => (params[0] as number) + 5);
        parser!.setFunction('GET_LETTER', (params: FormulaArg[]) => {
            const string = params[0] as string;
            const index = (params[1] as number) - 1;

            return string.charAt(index);
        });

        expect(parser!.parse('SUM(4, ADD_5(1))')).toMatchObject({
            error: null,
            result: 10,
        });
        expect(parser!.parse('GET_LETTER("Some string", 3)')).toMatchObject({
            error: null,
            result: 'm',
        });
    });

    test('should evaluate function with arguments passed as an stringified array', () => {
        expect(parser!.parse('SUM([])')).toMatchObject({ error: null, result: 0 });
        expect(parser!.parse('SUM([1])')).toMatchObject({ error: null, result: 1 });
        expect(parser!.parse('SUM([1,2,3])')).toMatchObject({
            error: null,
            result: 6,
        });
    });
});
