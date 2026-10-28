import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { Parser } from '../../../../../../engine/parser/parser';

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

    // Errors reach a trapping function two ways: returned by formulajs (NA()) or thrown by
    // one of our own operators (1/0). formulajs recognizes its errors by object identity, so
    // the thrown flavor used to slip past every trap — `IFERROR(1/0, "fb")` yielded #DIV/0!.
    it('IFERROR', () => {
        expect(parser!.parse('IFERROR(1, "fb")')).toMatchObject({ error: null, result: 1 });
        expect(parser!.parse('IFERROR(NA(), "fb")')).toMatchObject({ error: null, result: 'fb' });
        expect(parser!.parse('IFERROR(1/0, "fb")')).toMatchObject({ error: null, result: 'fb' });
        expect(parser!.parse('IFERROR(1 + "x", "fb")')).toMatchObject({ error: null, result: 'fb' });
    });

    // An unknown name or function is #NAME? like any other error, so IFERROR traps it, as in Excel.
    it('IFERROR traps an unknown name or function', () => {
        expect(parser!.parse('IFERROR(NOSUCHNAME, "fb")')).toMatchObject({ error: null, result: 'fb' });
        expect(parser!.parse('IFERROR(NOSUCH(1), "fb")')).toMatchObject({ error: null, result: 'fb' });
        expect(parser!.parse('ISERROR(NOSUCHNAME)')).toMatchObject({ error: null, result: true });
        expect(parser!.parse('NOSUCHNAME + 1')).toMatchObject({ error: '#NAME?', result: null });
        expect(parser!.parse('NOSUCH(1)')).toMatchObject({ error: '#NAME?', result: null });
    });

    // A real Excel function the engine lacks is #NAME? that nothing traps: a fallback would read as Excel's answer.
    it('IFERROR, IFNA and ISERROR leave the #NAME? of an Excel function the engine lacks', () => {
        expect(parser!.parse('IFERROR(FILTER(1, TRUE), "fb")')).toMatchObject({ error: '#NAME?', result: null });
        expect(parser!.parse('IFNA(INDIRECT("A1"), 0)')).toMatchObject({ error: '#NAME?', result: null });
        expect(parser!.parse('ISERROR(_xlfn.LET(x, 1, x))')).toMatchObject({ error: '#NAME?', result: null });
        expect(parser!.parse('IF(ISERR(OFFSET(1, 0, 0)), 0, 1)')).toMatchObject({ error: '#NAME?', result: null });
        expect(parser!.parse('ISERROR(FILTER(1, TRUE))')).toMatchObject({ error: '#NAME?', result: null });
        expect(parser!.parse('ISNA(FILTER(1, TRUE))')).toMatchObject({ error: '#NAME?', result: null });
        expect(parser!.parse('ERROR.TYPE(FILTER(1, TRUE))')).toMatchObject({ error: '#NAME?', result: null });
        expect(parser!.parse('IFERROR(FILTRE(1), "fb")')).toMatchObject({ error: null, result: 'fb' });
    });

    // Excel evaluates only the branch IF, CHOOSE, IFS, SWITCH or IFERROR takes, so the one it skips can hold a function
    // the engine lacks.
    it('a branch not taken may hold an Excel function the engine lacks', () => {
        expect(parser!.parse('IF(FALSE, FILTER(1, TRUE), 1)')).toMatchObject({ error: null, result: 1 });
        expect(parser!.parse('IF(TRUE, 1, LET(x, 1, x))')).toMatchObject({ error: null, result: 1 });
        expect(parser!.parse('CHOOSE(1, 5, FILTER(1, TRUE))')).toMatchObject({ error: null, result: 5 });
        expect(parser!.parse('IFS(FALSE, FILTER(1, TRUE), TRUE, 2)')).toMatchObject({ error: null, result: 2 });
        expect(parser!.parse('SWITCH(1, 1, "a", FILTER(1, TRUE))')).toMatchObject({ error: null, result: 'a' });
        expect(parser!.parse('IFERROR(1, FILTER(1, TRUE))')).toMatchObject({ error: null, result: 1 });
    });

    it('a branch taken, or a condition, holding an Excel function the engine lacks is #NAME?', () => {
        expect(parser!.parse('IF(TRUE, FILTER(1, TRUE), 1)')).toMatchObject({ error: '#NAME?', result: null });
        expect(parser!.parse('IF(FILTER(1, TRUE), 1, 2)')).toMatchObject({ error: '#NAME?', result: null });
        expect(parser!.parse('CHOOSE(FILTER(1, TRUE), 1, 2)')).toMatchObject({ error: '#NAME?', result: null });
        expect(parser!.parse('IFS(FILTER(1, TRUE), 1, TRUE, 2)')).toMatchObject({ error: '#NAME?', result: null });
        expect(parser!.parse('IFS(FALSE, 1, FILTER(1, TRUE), 2)')).toMatchObject({ error: '#NAME?', result: null });
        expect(parser!.parse('SWITCH(2, FILTER(1, TRUE), "a", "b")')).toMatchObject({ error: '#NAME?', result: null });
        expect(parser!.parse('SWITCH(FILTER(1, TRUE), 1, "a", "b")')).toMatchObject({ error: '#NAME?', result: null });
        expect(parser!.parse('IFERROR(1/0, FILTER(1, TRUE))')).toMatchObject({ error: '#NAME?', result: null });
    });

    it('any other function or operator hands on the #NAME? of an Excel function the engine lacks', () => {
        expect(parser!.parse('SUM(1, FILTER(1, TRUE))')).toMatchObject({ error: '#NAME?', result: null });
        expect(parser!.parse('ISNUMBER(FILTER(1, TRUE))')).toMatchObject({ error: '#NAME?', result: null });
        expect(parser!.parse('-FILTER(1, TRUE) + 1')).toMatchObject({ error: '#NAME?', result: null });
        expect(parser!.parse('IFERROR(CHOOSE(2, 5, FILTER(1, TRUE)), "fb")')).toMatchObject({
            error: '#NAME?',
            result: null,
        });
    });

    it('IFNA', () => {
        expect(parser!.parse('IFNA(1, "fb")')).toMatchObject({ error: null, result: 1 });
        expect(parser!.parse('IFNA(NA(), "fb")')).toMatchObject({ error: null, result: 'fb' });
        expect(parser!.parse('IFNA(1/0, "fb")')).toMatchObject({ error: '#DIV/0!', result: null });
        expect(parser!.parse('IFNA(NA(), 2)')).toMatchObject({ error: null, result: 2 });
    });

    it('ISERROR', () => {
        expect(parser!.parse('ISERROR(1)')).toMatchObject({ error: null, result: false });
        expect(parser!.parse('ISERROR(NA())')).toMatchObject({ error: null, result: true });
        expect(parser!.parse('ISERROR(1/0)')).toMatchObject({ error: null, result: true });
    });

    // An error typed into a formula is a value, as in Excel, so a function can inspect it.
    it('an error literal is a value', () => {
        expect(parser!.parse('ISERROR(#N/A)')).toMatchObject({ error: null, result: true });
        expect(parser!.parse('ISERROR(#NULL!)')).toMatchObject({ error: null, result: true });
        expect(parser!.parse('ERROR.TYPE(#N/A)')).toMatchObject({ error: null, result: 7 });
        expect(parser!.parse('IFERROR(#DIV/0!, 2)')).toMatchObject({ error: null, result: 2 });
        expect(parser!.parse('IF(TRUE, 1, #REF!)')).toMatchObject({ error: null, result: 1 });
        expect(parser!.parse('#N/A')).toMatchObject({ error: '#N/A', result: null });
        expect(parser!.parse('#N/A + 1')).toMatchObject({ error: '#N/A', result: null });
        expect(parser!.parse('#FOO!')).toMatchObject({ error: '#ERROR!', result: null });
    });

    it('ISERR', () => {
        expect(parser!.parse('ISERR(NA())')).toMatchObject({ error: null, result: false });
        expect(parser!.parse('ISERR(1/0)')).toMatchObject({ error: null, result: true });
    });

    it('ISNA', () => {
        expect(parser!.parse('ISNA(NA())')).toMatchObject({ error: null, result: true });
        expect(parser!.parse('ISNA(1/0)')).toMatchObject({ error: null, result: false });
    });
});
