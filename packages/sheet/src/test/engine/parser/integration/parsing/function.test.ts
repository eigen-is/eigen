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

    // Excel reads an empty argument slot as 0, wherever it sits in the list.
    test('should read an empty argument as 0', () => {
        expect(parser!.parse('SUM(1,,2)')).toMatchObject({ error: null, result: 3 });
        expect(parser!.parse('SUM(1, , 2)')).toMatchObject({ error: null, result: 3 });
        expect(parser!.parse('SUM(,1)')).toMatchObject({ error: null, result: 1 });
        expect(parser!.parse('SUM(1,)')).toMatchObject({ error: null, result: 1 });
        expect(parser!.parse('SUM(1,,)')).toMatchObject({ error: null, result: 1 });
        expect(parser!.parse('MAX(1,,2)')).toMatchObject({ error: null, result: 2 });
        expect(parser!.parse('IF(TRUE,,5)')).toMatchObject({ error: null, result: 0 });
        expect(parser!.parse('SUM()')).toMatchObject({ error: null, result: 0 });
        expect(parser!.parse('CONCATENATE("a,,b")')).toMatchObject({ error: null, result: 'a,,b' });
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
