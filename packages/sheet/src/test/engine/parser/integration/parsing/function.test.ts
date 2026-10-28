import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import Parser from '../../../../../engine/parser/parser';

describe('.parse() function', () => {
    let parser: Parser | null;

    beforeEach(() => {
        parser = new Parser();
    });
    afterEach(() => {
        parser = null;
    });

    test('should return #NAME? for an unknown function', () => {
        expect(parser!.parse('foo()')).toMatchObject({
            error: '#NAME?',
            result: null,
        });
    });

    // Google Sheets writes a function Excel lacks as `__xludf.DUMMYFUNCTION(…)` into an xlsx, and Excel
    // prefixes newer functions with `_xlfn.`. Such a name is an unknown function, not a syntax error.
    test('a function name may start with an underscore', () => {
        expect(parser!.parse('__xludf.DUMMYFUNCTION("x")')).toMatchObject({ error: '#NAME?', result: null });
        expect(parser!.parse('_xlfn.NOSUCH(1, 2)')).toMatchObject({ error: '#NAME?', result: null });
    });

    test('should evaluate function with arguments passed as an stringified array', () => {
        expect(parser!.parse('SUM([])')).toMatchObject({ error: null, result: 0 });
        expect(parser!.parse('SUM([1])')).toMatchObject({ error: null, result: 1 });
        expect(parser!.parse('SUM([1,2,3])')).toMatchObject({
            error: null,
            result: 6,
        });
    });

    test('an empty argument is 0, or "" for a text parameter, as in Excel', () => {
        expect(parser!.parse('SUM(1,,2)')).toMatchObject({ error: null, result: 3 });
        expect(parser!.parse('SUM(,1)')).toMatchObject({ error: null, result: 1 });
        expect(parser!.parse('SUM(1;;2)')).toMatchObject({ error: null, result: 3 });
        expect(parser!.parse('ROUND(2.5,)')).toMatchObject({ error: null, result: 3 });
        expect(parser!.parse('IF(TRUE,,1)')).toMatchObject({ error: null, result: 0 });
        expect(parser!.parse('IF(FALSE,1,)')).toMatchObject({ error: null, result: 0 });
        expect(parser!.parse('LEFT("abc",)')).toMatchObject({ error: null, result: '' });
        expect(parser!.parse('SUBSTITUTE("abc","a",)')).toMatchObject({ error: null, result: 'bc' });
        expect(parser!.parse('CONCATENATE("a",,"b")')).toMatchObject({ error: null, result: 'ab' });
        expect(parser!.parse('TEXT(5,)')).toEqual(parser!.parse('TEXT(5,"")'));
    });

    test('empty parentheses are no arguments, not one empty one', () => {
        expect(parser!.parse('IF(FALSE,1)')).toMatchObject({ error: null, result: false });
        expect(parser!.parse('ROUND(PI(),2)')).toMatchObject({ error: null, result: 3.14 });
    });
});
