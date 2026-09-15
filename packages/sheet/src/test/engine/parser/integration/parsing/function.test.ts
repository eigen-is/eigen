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

    test('should evaluate function with arguments passed as an stringified array', () => {
        expect(parser!.parse('SUM([])')).toMatchObject({ error: null, result: 0 });
        expect(parser!.parse('SUM([1])')).toMatchObject({ error: null, result: 1 });
        expect(parser!.parse('SUM([1,2,3])')).toMatchObject({
            error: null,
            result: 6,
        });
    });
});
