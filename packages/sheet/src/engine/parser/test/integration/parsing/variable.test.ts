import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import Parser from '../../../parser';

describe('.parse() variable', () => {
    let parser: Parser | null;

    beforeEach(() => {
        parser = new Parser();
    });
    afterEach(() => {
        parser = null;
    });

    test('should evaluate defaults variables', () => {
        expect(parser!.parse('TRUE')).toMatchObject({ error: null, result: true });
        expect(parser!.parse('FALSE')).toMatchObject({ error: null, result: false });
        expect(parser!.parse('NULL')).toMatchObject({ error: null, result: null });
    });

    test('should evaluate custom variables', () => {
        expect(parser!.parse('foo')).toMatchObject({
            error: '#NAME?',
            result: null,
        });

        parser!.setVariable('foo', 'bar');
        parser!.setVariable('baz', '6.6');

        expect(parser!.parse('foo')).toMatchObject({ error: null, result: 'bar' });
        expect(parser!.parse('SUM(baz, 2.1, 0.2)')).toMatchObject({
            error: null,
            result: 8.899999999999999,
        });
    });
});
