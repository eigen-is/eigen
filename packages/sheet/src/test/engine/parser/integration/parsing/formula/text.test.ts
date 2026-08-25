import { afterEach, beforeEach, describe, expect, it, xit } from 'bun:test';
import Parser from '../../../../../../engine/parser/parser';

describe('.parse() text formulas', () => {
    let parser: Parser | null;

    beforeEach(() => {
        parser = new Parser();
    });
    afterEach(() => {
        parser = null;
    });

    it('CHAR', () => {
        expect(parser!.parse('CHAR()')).toMatchObject({
            error: '#VALUE!',
            result: null,
        });
        expect(parser!.parse('CHAR(33)')).toMatchObject({
            error: null,
            result: '!',
        });
    });

    it('CLEAN', () => {
        expect(parser!.parse('CLEAN()')).toMatchObject({ error: null, result: '' });
        expect(parser!.parse('CLEAN(CHAR(9)&"Monthly report"&CHAR(10))')).toMatchObject({
            error: null,
            result: 'Monthly report',
        });
    });

    it('CODE', () => {
        expect(parser!.parse('CODE()')).toMatchObject({
            error: '#VALUE!',
            result: null,
        });
        expect(parser!.parse('CODE("a")')).toMatchObject({
            error: null,
            result: 97,
        });
    });

    it('CONCATENATE', () => {
        expect(parser!.parse('CONCATENATE()')).toMatchObject({
            error: null,
            result: '',
        });
        expect(parser!.parse('CONCATENATE("a")')).toMatchObject({
            error: null,
            result: 'a',
        });
        expect(parser!.parse('CONCATENATE("a", 1)')).toMatchObject({
            error: null,
            result: 'a1',
        });
        expect(parser!.parse('CONCATENATE("a", 1, TRUE)')).toMatchObject({
            error: null,
            result: 'a1TRUE',
        });
    });

    xit('DOLLAR', () => {
        expect(parser!.parse('DOLLAR()')).toMatchObject({
            error: '#VALUE!',
            result: null,
        });
        expect(parser!.parse('DOLLAR(1100)')).toMatchObject({
            error: null,
            result: '$1,100.00',
        });
        expect(parser!.parse('DOLLAR(1100, -2)')).toMatchObject({
            error: null,
            result: '$1,100',
        });
    });

    it('EXACT', () => {
        expect(parser!.parse('EXACT()')).toMatchObject({
            error: '#N/A',
            result: null,
        });
        expect(parser!.parse('EXACT(1100)')).toMatchObject({
            error: '#N/A',
            result: null,
        });
        expect(parser!.parse('EXACT(1100, -2)')).toMatchObject({
            error: null,
            result: false,
        });
        expect(parser!.parse('EXACT(1100, 1100)')).toMatchObject({
            error: null,
            result: true,
        });
        expect(parser!.parse('EXACT(1100, "1100")')).toMatchObject({
            error: null,
            result: true,
        });
    });

    it('FIND', () => {
        expect(parser!.parse('FIND()')).toMatchObject({
            error: '#N/A',
            result: null,
        });
        expect(parser!.parse('FIND("o")')).toMatchObject({
            error: '#N/A',
            result: null,
        });
        expect(parser!.parse('FIND("o", "FooBar")')).toMatchObject({
            error: null,
            result: 2,
        });
        expect(parser!.parse('FIND("O", "FooBar")')).toMatchObject({
            error: '#VALUE!',
            result: null,
        });
    });

    xit('FIXED', () => {
        expect(parser!.parse('FIXED()')).toMatchObject({
            error: '#VALUE!',
            result: null,
        });
        expect(parser!.parse('FIXED(12345.11, -1)')).toMatchObject({
            error: null,
            result: '12,350',
        });
        expect(parser!.parse('FIXED(12345.11, 0)')).toMatchObject({
            error: null,
            result: '12,345',
        });
        expect(parser!.parse('FIXED(12345.11, 0, TRUE)')).toMatchObject({
            error: null,
            result: '12345',
        });
        expect(parser!.parse('FIXED(12345.11, 4, TRUE)')).toMatchObject({
            error: null,
            result: '12345.1100',
        });
    });

    xit('HTML2TEXT', () => {
        // HTML2TEXT is not available in @formulajs/formulajs
        expect(parser!.parse('HTML2TEXT()')).toMatchObject({
            error: null,
            result: '',
        });
        expect(parser!.parse('HTML2TEXT("Click <a>Link</a>")')).toMatchObject({
            error: null,
            result: 'Click Link',
        });
    });

    it('LEFT', () => {
        expect(parser!.parse('LEFT()')).toMatchObject({
            error: null,
            result: '',
        });
        expect(parser!.parse('LEFT("Foo Bar")')).toMatchObject({
            error: null,
            result: 'F',
        });
        expect(parser!.parse('LEFT("Foo Bar", 3)')).toMatchObject({
            error: null,
            result: 'Foo',
        });
    });

    it('LEN', () => {
        expect(parser!.parse('LEN()')).toMatchObject({
            error: '#ERROR!',
            result: null,
        });
        expect(parser!.parse('LEN(TRUE)')).toMatchObject({
            error: null,
            result: 4,
        });
        expect(parser!.parse('LEN(1023)')).toMatchObject({
            error: null,
            result: 4,
        });
        expect(parser!.parse('LEN("Foo Bar")')).toMatchObject({
            error: null,
            result: 7,
        });
    });

    it('LOWER', () => {
        expect(parser!.parse('LOWER()')).toMatchObject({
            error: '#VALUE!',
            result: null,
        });
        expect(parser!.parse('LOWER("")')).toMatchObject({
            error: null,
            result: '',
        });
        expect(parser!.parse('LOWER("Foo Bar")')).toMatchObject({
            error: null,
            result: 'foo bar',
        });
    });

    it('MID', () => {
        expect(parser!.parse('MID()')).toMatchObject({
            error: '#VALUE!',
            result: null,
        });
        expect(parser!.parse('MID("")')).toMatchObject({
            error: '#VALUE!',
            result: null,
        });
        expect(parser!.parse('MID("Foo Bar", 2)')).toMatchObject({
            error: null,
            result: '',
        });
        expect(parser!.parse('MID("Foo Bar", 2, 5)')).toMatchObject({
            error: null,
            result: 'oo Ba',
        });
    });

    it('PROPER', () => {
        expect(parser!.parse('PROPER()')).toMatchObject({
            error: null,
            result: '',
        });
        expect(parser!.parse('PROPER("")')).toMatchObject({
            error: null,
            result: '',
        });
        expect(parser!.parse('PROPER(TRUE)')).toMatchObject({
            error: null,
            result: 'True',
        });
        expect(parser!.parse('PROPER(1234)')).toMatchObject({
            error: null,
            result: '1234',
        });
        expect(parser!.parse('PROPER("foo bar")')).toMatchObject({
            error: null,
            result: 'Foo Bar',
        });
    });

    xit('REGEXEXTRACT', () => {
        // REGEXEXTRACT is not available in @formulajs/formulajs
        expect(parser!.parse('REGEXEXTRACT()')).toMatchObject({
            error: '#N/A',
            result: null,
        });
        expect(parser!.parse('REGEXEXTRACT("extract foo bar", "(foo)")')).toMatchObject({ error: null, result: 'foo' });
        expect(parser!.parse('REGEXEXTRACT("pressure 12.21bar", "([0-9]+.[0-9]+)")')).toMatchObject({
            error: null,
            result: '12.21',
        });
    });

    xit('REGEXREPLACE', () => {
        // REGEXREPLACE is not available in @formulajs/formulajs
        expect(parser!.parse('REGEXREPLACE()')).toMatchObject({
            error: '#N/A',
            result: null,
        });
        expect(parser!.parse('REGEXREPLACE("extract foo bar", "(foo)", "baz")')).toMatchObject({
            error: null,
            result: 'extract baz bar',
        });
        expect(parser!.parse('REGEXREPLACE("pressure 12.21bar", "([0-9]+.[0-9]+)", "43.1")')).toMatchObject({
            error: null,
            result: 'pressure 43.1bar',
        });
    });

    xit('REGEXMATCH', () => {
        // REGEXMATCH is not available in @formulajs/formulajs
        expect(parser!.parse('REGEXMATCH()')).toMatchObject({
            error: '#N/A',
            result: null,
        });
        expect(parser!.parse('REGEXMATCH("pressure 12.21bar", "([0-9]+.[0-9]+)")')).toMatchObject({
            error: null,
            result: true,
        });

        const result = parser!.parse('REGEXMATCH("pressure 12.33bar", "([0-9]+.[0-9]+)", TRUE)');

        expect(result).toBeInstanceOf(Object);
    });

    it('REPLACE', () => {
        expect(parser!.parse('REPLACE()')).toMatchObject({
            error: '#VALUE!',
            result: null,
        });
        expect(parser!.parse('REPLACE("foo bar")')).toMatchObject({
            error: '#VALUE!',
            result: null,
        });
        expect(parser!.parse('REPLACE("foo bar", 2)')).toMatchObject({
            error: '#VALUE!',
            result: null,
        });
        expect(parser!.parse('REPLACE("foo bar", 2, 5)')).toMatchObject({
            error: '#VALUE!',
            result: null,
        });
        expect(parser!.parse('REPLACE("foo bar", 2, 5, "*")')).toMatchObject({
            error: null,
            result: 'f*r',
        });
    });

    it('REPT', () => {
        expect(parser!.parse('REPT()')).toMatchObject({
            error: null,
            result: '',
        });
        expect(parser!.parse('REPT("foo ")')).toMatchObject({
            error: null,
            result: '',
        });
        expect(parser!.parse('REPT("foo ", 5)')).toMatchObject({
            error: null,
            result: 'foo foo foo foo foo ',
        });
    });

    it('RIGHT', () => {
        expect(parser!.parse('RIGHT()')).toMatchObject({
            error: null,
            result: '',
        });
        expect(parser!.parse('RIGHT("foo bar")')).toMatchObject({
            error: null,
            result: 'r',
        });
        expect(parser!.parse('RIGHT("foo bar", 4)')).toMatchObject({
            error: null,
            result: ' bar',
        });
    });

    it('SEARCH', () => {
        expect(parser!.parse('SEARCH()')).toMatchObject({
            error: '#VALUE!',
            result: null,
        });
        expect(parser!.parse('SEARCH("bar")')).toMatchObject({
            error: '#VALUE!',
            result: null,
        });
        expect(parser!.parse('SEARCH("bar", "foo bar")')).toMatchObject({
            error: null,
            result: 5,
        });
    });

    xit('SPLIT', () => {
        // SPLIT is not available in @formulajs/formulajs
        expect(parser!.parse('SPLIT()')).toMatchObject({
            error: '#ERROR!',
            result: null,
        });
        expect(parser!.parse('SPLIT("foo bar baz")')).toMatchObject({
            error: null,
            result: ['foo bar baz'],
        });
        expect(parser!.parse('SPLIT("foo bar baz", " ")')).toMatchObject({
            error: null,
            result: ['foo', 'bar', 'baz'],
        });
    });

    it('SUBSTITUTE', () => {
        expect(parser!.parse('SUBSTITUTE()')).toMatchObject({
            error: '#N/A',
            result: null,
        });
        expect(parser!.parse('SUBSTITUTE("foo bar baz")')).toMatchObject({
            error: '#N/A',
            result: null,
        });
        expect(parser!.parse('SUBSTITUTE("foo bar baz", "a", "A")')).toMatchObject({
            error: null,
            result: 'foo bAr bAz',
        });
    });

    it('T', () => {
        expect(parser!.parse('T()')).toMatchObject({ error: '#ERROR!', result: null });
        expect(parser!.parse('T(TRUE)')).toMatchObject({ error: '#ERROR!', result: null });
        expect(parser!.parse('T(9.887)')).toMatchObject({ error: '#ERROR!', result: null });
        expect(parser!.parse('T("foo bar baz")')).toMatchObject({
            error: '#ERROR!',
            result: null,
        });
    });

    xit('TEXT', () => {
        expect(parser!.parse('TEXT()')).toMatchObject({
            error: '#N/A',
            result: null,
        });
        expect(parser!.parse('TEXT(1234.99)')).toMatchObject({
            error: null,
            result: '1,235',
        });
        expect(parser!.parse('TEXT(1234.99, "####.#")')).toMatchObject({
            error: null,
            result: '1235.0',
        });
        expect(parser!.parse('TEXT(1234.99, "####.###")')).toMatchObject({
            error: null,
            result: '1234.990',
        });
    });

    it('TRIM', () => {
        expect(parser!.parse('TRIM()')).toMatchObject({
            error: null,
            result: '',
        });
        expect(parser!.parse('TRIM("")')).toMatchObject({ error: null, result: '' });
        expect(parser!.parse('TRIM("     ")')).toMatchObject({
            error: null,
            result: '',
        });
        expect(parser!.parse('TRIM("   foo  ")')).toMatchObject({
            error: null,
            result: 'foo',
        });
    });

    it('UNICHAR', () => {
        expect(parser!.parse('UNICHAR()')).toMatchObject({
            error: '#VALUE!',
            result: null,
        });
        expect(parser!.parse('UNICHAR(33)')).toMatchObject({
            error: null,
            result: '!',
        });
    });

    it('UNICODE', () => {
        expect(parser!.parse('UNICODE()')).toMatchObject({
            error: '#VALUE!',
            result: null,
        });
        expect(parser!.parse('UNICODE("!")')).toMatchObject({
            error: null,
            result: 33,
        });
    });

    it('UPPER', () => {
        expect(parser!.parse('UPPER()')).toMatchObject({
            error: null,
            result: '',
        });
        expect(parser!.parse('UPPER("foo Bar")')).toMatchObject({
            error: null,
            result: 'FOO BAR',
        });
    });

    xit('VALUE', () => {
        expect(parser!.parse('VALUE()')).toMatchObject({
            error: '#VALUE!',
            result: null,
        });
        expect(parser!.parse('VALUE("$1,000")')).toMatchObject({
            error: null,
            result: 1000,
        });
        expect(parser!.parse('VALUE("01:00:00")')).toMatchObject({
            error: null,
            result: 3600,
        });
        expect(parser!.parse('VALUE("foo Bar")')).toMatchObject({
            error: null,
            result: 0,
        });
    });

    // formulajs.VALUE rejects numeric inputs with #VALUE!, but Excel accepts
    // numbers (and booleans) as a pass-through. Calendar templates use
    // `VALUE(prevDay) > daysInMonth` to gate spillover days; without this
    // override the comparison silently fails and ghost days appear.
    it('VALUE passes numbers and booleans through (Excel-correct)', () => {
        expect(parser!.parse('VALUE(31)')).toMatchObject({ error: null, result: 31 });
        expect(parser!.parse('VALUE(0)')).toMatchObject({ error: null, result: 0 });
        expect(parser!.parse('VALUE(-1.5)')).toMatchObject({ error: null, result: -1.5 });
        expect(parser!.parse('VALUE(TRUE)')).toMatchObject({ error: null, result: 1 });
        expect(parser!.parse('VALUE(FALSE)')).toMatchObject({ error: null, result: 0 });
    });
});
