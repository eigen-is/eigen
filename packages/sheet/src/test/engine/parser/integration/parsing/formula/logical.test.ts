import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import Parser from '../../../../../../engine/parser/parser';

describe('.parse() logical formulas', () => {
    let parser: Parser | null;

    beforeEach(() => {
        parser = new Parser();
    });
    afterEach(() => {
        parser = null;
    });

    it('AND', () => {
        expect(parser!.parse('AND()')).toMatchObject({ error: '#VALUE!', result: null });
        expect(parser!.parse('AND(TRUE, TRUE, FALSE)')).toMatchObject({
            error: null,
            result: false,
        });
        expect(parser!.parse('AND(TRUE, TRUE, TRUE)')).toMatchObject({
            error: null,
            result: true,
        });
    });

    it('CHOOSE', () => {
        expect(parser!.parse('CHOOSE()')).toMatchObject({
            error: '#N/A',
            result: null,
        });
        expect(parser!.parse('CHOOSE(1, "foo", "bar", "baz")')).toMatchObject({
            error: null,
            result: 'foo',
        });
        expect(parser!.parse('CHOOSE(3, "foo", "bar", "baz")')).toMatchObject({
            error: null,
            result: 'baz',
        });
        expect(parser!.parse('CHOOSE(4, "foo", "bar", "baz")')).toMatchObject({
            error: '#VALUE!',
            result: null,
        });
    });

    it('FALSE', () => {
        expect(parser!.parse('FALSE()')).toMatchObject({
            error: null,
            result: false,
        });
    });

    it('IF', () => {
        expect(parser!.parse('IF()')).toMatchObject({ error: null, result: false });
        expect(parser!.parse('IF(TRUE, 1, 2)')).toMatchObject({
            error: null,
            result: 1,
        });
        expect(parser!.parse('IF(FALSE, 1, 2)')).toMatchObject({
            error: null,
            result: 2,
        });
    });

    // Excel's IF skips the untaken branch, so an erroring branch in the path
    // not chosen must not surface. The grammar evaluates both arms eagerly, so
    // we rely on errors flowing through as in-band Error values rather than
    // throws. Calendar templates that read empty IF results back through `+`
    // (e.g. `IF(prev<>"", prev+1, fallback)` with `prev=""`) depend on this.
    it('IF skips errors in the untaken branch', () => {
        expect(parser!.parse('IF(FALSE, "x"+1, "ok")')).toMatchObject({
            error: null,
            result: 'ok',
        });
        expect(parser!.parse('IF(TRUE, 5, "x"+1)')).toMatchObject({
            error: null,
            result: 5,
        });
        expect(parser!.parse('IF(""<>"", ""+1, IF(TRUE, 7, ""))')).toMatchObject({
            error: null,
            result: 7,
        });
        // A taken branch that errors still surfaces as #VALUE!.
        expect(parser!.parse('IF(TRUE, "x"+1, "ok")')).toMatchObject({
            error: '#VALUE!',
            result: null,
        });
        expect(parser!.parse('IF(FALSE, 5, "x"+1)')).toMatchObject({
            error: '#VALUE!',
            result: null,
        });
    });

    it('NOT', () => {
        expect(parser!.parse('NOT()')).toMatchObject({ error: null, result: true });
        expect(parser!.parse('NOT(TRUE)')).toMatchObject({
            error: null,
            result: false,
        });
        expect(parser!.parse('NOT(FALSE)')).toMatchObject({
            error: null,
            result: true,
        });
        expect(parser!.parse('NOT(0)')).toMatchObject({ error: null, result: true });
        expect(parser!.parse('NOT(1)')).toMatchObject({
            error: null,
            result: false,
        });
    });

    it('OR', () => {
        expect(parser!.parse('OR()')).toMatchObject({ error: '#VALUE!', result: null });
        expect(parser!.parse('OR(TRUE, TRUE, TRUE)')).toMatchObject({
            error: null,
            result: true,
        });
        expect(parser!.parse('OR(TRUE, FALSE, FALSE)')).toMatchObject({
            error: null,
            result: true,
        });
        expect(parser!.parse('OR(FALSE, FALSE, FALSE)')).toMatchObject({
            error: null,
            result: false,
        });
    });

    it('TRUE', () => {
        expect(parser!.parse('TRUE()')).toMatchObject({ error: null, result: true });
    });

    it('XOR', () => {
        expect(parser!.parse('XOR()')).toMatchObject({ error: '#VALUE!', result: null });
        expect(parser!.parse('XOR(TRUE, TRUE)')).toMatchObject({
            error: null,
            result: false,
        });
        expect(parser!.parse('XOR(TRUE, FALSE)')).toMatchObject({
            error: null,
            result: true,
        });
        expect(parser!.parse('XOR(FALSE, TRUE)')).toMatchObject({
            error: null,
            result: true,
        });
        expect(parser!.parse('XOR(FALSE, FALSE)')).toMatchObject({
            error: null,
            result: false,
        });
    });

    it('SWITCH', () => {
        expect(parser!.parse('SWITCH()')).toMatchObject({
            error: '#VALUE!',
            result: null,
        });
        expect(parser!.parse('SWITCH(7, "foo")')).toMatchObject({
            error: null,
            result: 'foo',
        });
        expect(parser!.parse('SWITCH(7, 9, "foo", 7, "bar")')).toMatchObject({
            error: null,
            result: 'bar',
        });
        expect(parser!.parse('SWITCH(10, 9, "foo", 7, "bar")')).toMatchObject({
            error: '#N/A',
            result: null,
        });
    });
});
