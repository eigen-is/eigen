import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import Parser from '../../../../../engine/parser/parser';

describe('.parse() math', () => {
    let parser: Parser | null;

    beforeEach(() => {
        parser = new Parser();
    });
    afterEach(() => {
        parser = null;
    });

    test('operator: +', () => {
        expect(parser!.parse('10+10')).toMatchObject({ error: null, result: 20 });
        expect(parser!.parse('10 + 10')).toMatchObject({ error: null, result: 20 });
        expect(parser!.parse('10 + 11 + 23 + 11 + 2')).toMatchObject({
            error: null,
            result: 57,
        });
        expect(parser!.parse('1.4425 + 4.333')).toMatchObject({
            error: null,
            result: 5.7755,
        });
        expect(parser!.parse('"foo" + 4.333')).toMatchObject({
            error: '#VALUE!',
            result: null,
        });
    });

    test('operator: -', () => {
        expect(parser!.parse('10-10')).toMatchObject({ error: null, result: 0 });
        expect(parser!.parse('10 - 10')).toMatchObject({ error: null, result: 0 });
        expect(parser!.parse('10 - 10 - 2')).toMatchObject({
            error: null,
            result: -2,
        });
        expect(parser!.parse('10 - 11 - 23 - 11 - 2')).toMatchObject({
            error: null,
            result: -37,
        });
        expect(parser!.parse('"foo" - 4.333')).toMatchObject({
            error: '#VALUE!',
            result: null,
        });
    });

    test('operator: /', () => {
        expect(parser!.parse('2 / 1')).toMatchObject({ error: null, result: 2 });
        expect(parser!.parse('64 / 2 / 4')).toMatchObject({
            error: null,
            result: 8,
        });
        expect(parser!.parse('2 / 0')).toMatchObject({
            error: '#DIV/0!',
            result: null,
        });
        expect(parser!.parse('0 / 0')).toMatchObject({
            error: '#DIV/0!',
            result: null,
        });
        expect(parser!.parse('"foo" / 4.333')).toMatchObject({
            error: '#VALUE!',
            result: null,
        });
        expect(parser!.parse('4.333 / "foo"')).toMatchObject({
            error: '#VALUE!',
            result: null,
        });
        // A blank operand is 0, as everywhere else: as a divisor that is #DIV/0!, as a dividend 0.
        expect(parser!.parse('1 / A1')).toMatchObject({ error: '#DIV/0!', result: null });
        expect(parser!.parse('A1 / 2')).toMatchObject({ error: null, result: 0 });
    });

    test('operator: *', () => {
        expect(parser!.parse('0 * 0 * 0 * 0 * 0')).toMatchObject({
            error: null,
            result: 0,
        });
        expect(parser!.parse('2 * 1')).toMatchObject({ error: null, result: 2 });
        expect(parser!.parse('64 * 2 * 4')).toMatchObject({
            error: null,
            result: 512,
        });
        expect(parser!.parse('"foo" * 4.333')).toMatchObject({
            error: '#VALUE!',
            result: null,
        });
    });

    test('operator: ^', () => {
        expect(parser!.parse('2 ^ 5')).toMatchObject({ error: null, result: 32 });
        expect(parser!.parse('"foo" ^ 4')).toMatchObject({
            error: '#VALUE!',
            result: null,
        });
    });

    test('an overflowing result is #NUM!, not Infinity', () => {
        expect(parser!.parse('1E308 + 1E308')).toMatchObject({ error: '#NUM!', result: null });
        expect(parser!.parse('-1E308 - 1E308')).toMatchObject({ error: '#NUM!', result: null });
        expect(parser!.parse('1E308 * 10')).toMatchObject({ error: '#NUM!', result: null });
        expect(parser!.parse('1E308 / 0.1')).toMatchObject({ error: '#NUM!', result: null });
        expect(parser!.parse('2 ^ 10000')).toMatchObject({ error: '#NUM!', result: null });
        expect(parser!.parse('-(2 ^ 10000)')).toMatchObject({ error: '#NUM!', result: null });
        expect(parser!.parse('0 ^ -1')).toMatchObject({ error: '#DIV/0!', result: null });
        expect(parser!.parse('1 / 0')).toMatchObject({ error: '#DIV/0!', result: null });
    });

    // Excel binds negation tighter than `^`, so `-2^2` is (-2)^2 = 4, not -(2^2).
    test('unary sign binds tighter than ^', () => {
        expect(parser!.parse('-2 ^ 2')).toMatchObject({ error: null, result: 4 });
        expect(parser!.parse('+2 ^ 2')).toMatchObject({ error: null, result: 4 });
        expect(parser!.parse('-2 ^ 3')).toMatchObject({ error: null, result: -8 });
        expect(parser!.parse('2 ^ -3')).toMatchObject({ error: null, result: 0.125 });
        expect(parser!.parse('-2 ^ -2')).toMatchObject({ error: null, result: 0.25 });
        expect(parser!.parse('-(2 ^ 2)')).toMatchObject({ error: null, result: -4 });
    });

    test('operator: &', () => {
        expect(parser!.parse('2 & 5')).toMatchObject({ error: null, result: '25' });
        expect(parser!.parse('(2 & 5)')).toMatchObject({
            error: null,
            result: '25',
        });
        expect(parser!.parse('("" & "")')).toMatchObject({
            error: null,
            result: '',
        });
        expect(parser!.parse('"" & ""')).toMatchObject({ error: null, result: '' });
        expect(parser!.parse('("Hello" & " world") & "!"')).toMatchObject({
            error: null,
            result: 'Hello world!',
        });
        expect(parser!.parse('TRUE & "x"')).toMatchObject({ error: null, result: 'TRUEx' });
        expect(parser!.parse('"a" & FALSE')).toMatchObject({ error: null, result: 'aFALSE' });
        // A formulajs Date concatenates as its serial, not as Date.toString().
        expect(parser!.parse('DATE(2026, 1, 5) & "x"')).toMatchObject({ error: null, result: '46027x' });
    });

    test('unary sign', () => {
        expect(parser!.parse('-"3"')).toMatchObject({ error: null, result: -3 });
        expect(parser!.parse('+"3"')).toMatchObject({ error: null, result: 3 });
        expect(parser!.parse('-TRUE')).toMatchObject({ error: null, result: -1 });
        // A blank cell coerces to 0, an unparseable string is #VALUE! — not a silent 0.
        expect(parser!.parse('-A1')).toMatchObject({ error: null, result: 0 });
        expect(parser!.parse('-"a"')).toMatchObject({ error: '#VALUE!', result: null });
        expect(parser!.parse('+"a"')).toMatchObject({ error: '#VALUE!', result: null });
        // An Error operand propagates like it does through the binary operators.
        expect(parser!.parse('-(1/0)')).toMatchObject({ error: '#DIV/0!', result: null });
        expect(parser!.parse('-NA()')).toMatchObject({ error: '#N/A', result: null });
        expect(parser!.parse('+NA()')).toMatchObject({ error: '#N/A', result: null });
    });

    test('number literals', () => {
        expect(parser!.parse('1e3')).toMatchObject({ error: null, result: 1000 });
        expect(parser!.parse('1E3')).toMatchObject({ error: null, result: 1000 });
        expect(parser!.parse('1.5e-3')).toMatchObject({ error: null, result: 0.0015 });
        expect(parser!.parse('2e+2 + 1')).toMatchObject({ error: null, result: 201 });
        expect(parser!.parse('.5')).toMatchObject({ error: null, result: 0.5 });
        expect(parser!.parse('-.5')).toMatchObject({ error: null, result: -0.5 });
        expect(parser!.parse('.5 + .25')).toMatchObject({ error: null, result: 0.75 });
        expect(parser!.parse('1.5')).toMatchObject({ error: null, result: 1.5 });
        expect(parser!.parse('50%')).toMatchObject({ error: null, result: 0.5 });
        expect(parser!.parse('SUM(.5, 1e1)')).toMatchObject({ error: null, result: 10.5 });
    });

    test('mixed operators', () => {
        expect(parser!.parse('1 + 10 - 20 * 3/2')).toMatchObject({
            error: null,
            result: -19,
        });
        expect(parser!.parse('((1 + 10 - 20 * 3 / 2) + 20) * 10')).toMatchObject({
            error: null,
            result: 10,
        });
        expect(parser!.parse('(((1 + 10 - 20 * 3/2) + 20) * 10) / 5.12')).toMatchObject({
            error: null,
            result: 1.953125,
        });
        expect(parser!.parse('(((1 + "foo" - 20 * 3/2) + 20) * 10) / 5.12')).toMatchObject({
            error: '#VALUE!',
            result: null,
        });
    });
});
