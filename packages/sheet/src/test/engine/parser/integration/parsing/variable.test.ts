import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import Parser from '../../../../../engine/parser/parser';

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

    // Excel and Google Sheets treat TRUE/FALSE/NULL as case-insensitive, and Excel writes
    // them lower-cased into xlsx formula text — an imported `VLOOKUP(A1,B:C,2,false)` used
    // to resolve `false` as an unknown name and return #NAME?.
    test('should evaluate defaults variables regardless of case', () => {
        expect(parser!.parse('true')).toMatchObject({ error: null, result: true });
        expect(parser!.parse('False')).toMatchObject({ error: null, result: false });
        expect(parser!.parse('null')).toMatchObject({ error: null, result: null });
        expect(parser!.parse('IF(false, 1, 2)')).toMatchObject({ error: null, result: 2 });
    });

    test('should evaluate custom variables regardless of case', () => {
        parser!.setVariable('Foo', 'bar');

        expect(parser!.parse('foo')).toMatchObject({ error: null, result: 'bar' });
        expect(parser!.parse('FOO')).toMatchObject({ error: null, result: 'bar' });
        expect(parser!.getVariable('foo')).toBe('bar');
    });
});
