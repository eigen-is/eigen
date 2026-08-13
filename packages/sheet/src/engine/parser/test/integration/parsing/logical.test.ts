import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import Parser from '../../../parser';

describe('.parse() logical', () => {
    let parser: Parser | null;

    beforeEach(() => {
        parser = new Parser();
    });
    afterEach(() => {
        parser = null;
    });

    test('operator: =', () => {
        expect(parser!.parse('10 = 10')).toMatchObject({
            error: null,
            result: true,
        });

        expect(parser!.parse('10 = 11')).toMatchObject({
            error: null,
            result: false,
        });
    });

    test('operator: = coerces and case-folds (Excel parity)', () => {
        expect(parser!.parse('"A" = "a"')).toMatchObject({ error: null, result: true });
        expect(parser!.parse('1 = "1"')).toMatchObject({ error: null, result: true });
        expect(parser!.parse('"1.0" = "1"')).toMatchObject({ error: null, result: true });
        expect(parser!.parse('"abc" = 1')).toMatchObject({ error: null, result: false });
        expect(parser!.parse('"A" <> "a"')).toMatchObject({ error: null, result: false });
        expect(parser!.parse('1 <> "1"')).toMatchObject({ error: null, result: false });
    });

    test('operator: >', () => {
        expect(parser!.parse('11 > 10')).toMatchObject({
            error: null,
            result: true,
        });
        expect(parser!.parse('10 > 1.1')).toMatchObject({
            error: null,
            result: true,
        });
        expect(parser!.parse('10 >- 10')).toMatchObject({
            error: null,
            result: true,
        });

        expect(parser!.parse('10 > 11')).toMatchObject({
            error: null,
            result: false,
        });
        expect(parser!.parse('10 > 11.1')).toMatchObject({
            error: null,
            result: false,
        });
        expect(parser!.parse('10 > 10.00001')).toMatchObject({
            error: null,
            result: false,
        });
    });

    test('operator: <', () => {
        expect(parser!.parse('10 < 11')).toMatchObject({
            error: null,
            result: true,
        });
        expect(parser!.parse('10 < 11.1')).toMatchObject({
            error: null,
            result: true,
        });
        expect(parser!.parse('10 < 10.00001')).toMatchObject({
            error: null,
            result: true,
        });

        expect(parser!.parse('11 < 10')).toMatchObject({
            error: null,
            result: false,
        });
        expect(parser!.parse('10 < 1.1')).toMatchObject({
            error: null,
            result: false,
        });
        expect(parser!.parse('10 <- 10')).toMatchObject({
            error: null,
            result: false,
        });
    });

    test('operator: >=', () => {
        expect(parser!.parse('11 >= 10')).toMatchObject({
            error: null,
            result: true,
        });
        expect(parser!.parse('11 >= 11')).toMatchObject({
            error: null,
            result: true,
        });
        expect(parser!.parse('10 >= 10')).toMatchObject({
            error: null,
            result: true,
        });
        expect(parser!.parse('10 >= -10')).toMatchObject({
            error: null,
            result: true,
        });

        expect(parser!.parse('10 >= 11')).toMatchObject({
            error: null,
            result: false,
        });
        expect(parser!.parse('10 >= 11.1')).toMatchObject({
            error: null,
            result: false,
        });
        expect(parser!.parse('10 >= 10.00001')).toMatchObject({
            error: null,
            result: false,
        });
    });

    test('operator: <=', () => {
        expect(parser!.parse('10 <= 10')).toMatchObject({
            error: null,
            result: true,
        });
        expect(parser!.parse('1.1 <= 10')).toMatchObject({
            error: null,
            result: true,
        });
        expect(parser!.parse('-10 <= 10')).toMatchObject({
            error: null,
            result: true,
        });

        expect(parser!.parse('11 <= 10')).toMatchObject({
            error: null,
            result: false,
        });
        expect(parser!.parse('11.1 <= 10')).toMatchObject({
            error: null,
            result: false,
        });
        expect(parser!.parse('10.00001 <= 10')).toMatchObject({
            error: null,
            result: false,
        });
    });

    test('operator: <>', () => {
        expect(parser!.parse('10 <> 11')).toMatchObject({
            error: null,
            result: true,
        });
        expect(parser!.parse('1.1 <> 10')).toMatchObject({
            error: null,
            result: true,
        });
        expect(parser!.parse('-10 <> 10')).toMatchObject({
            error: null,
            result: true,
        });

        expect(parser!.parse('10 <> 10')).toMatchObject({
            error: null,
            result: false,
        });
        expect(parser!.parse('11.1 <> 11.1')).toMatchObject({
            error: null,
            result: false,
        });
        expect(parser!.parse('10.00001 <> 10.00001')).toMatchObject({
            error: null,
            result: false,
        });
    });
});
