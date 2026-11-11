import { describe, expect, test } from 'bun:test';
import type { Entry, Param } from '../../eval/signature';
import { Prepare, Read } from '../../eval/signature';
import { FUNCTIONS } from '../../functions/library';
import type { FormulaError } from '../../index';
import { DIV0, NA, VALUE } from '../../index';
import type { Cells } from '../recalc/support';
import { engineOf, valueAt } from '../recalc/support';

// Every law below is derived from a row's own data, for every row of the one table: no law names a function.
// A1:A5 = 10..50, B1:B5 = a..e, C1:C3 = 1, 2, 3, D1 = TRUE, Z9 is blank.
const SHEET: Cells = {
    ...{ A1: 10, A2: 20, A3: 30, A4: 40, A5: 50 },
    ...{ B1: 'a', B2: 'b', B3: 'c', B4: 'd', B5: 'e' },
    ...{ C1: 1, C2: 2, C3: 3, D1: true },
};

const ROWS: Entry[] = [];
for (const entry of FUNCTIONS.values()) if (!('flags' in entry)) ROWS.push(entry);

// A row for which no call from the pools answers a value names one here.
const BASES: Readonly<Record<string, readonly string[]>> = {};
// The one row whose answer is an error by definition.
const ERRORS = new Set(['NA']);

// What can be written for a parameter, by its reading: values every reading of that kind takes.
function pool(param: Param<unknown>): readonly string[] {
    switch (param.read) {
        case Read.Number:
        case Read.Integer:
            return ['1', '2', '0.5', '10'];
        case Read.Text:
            return ['"abc"', '"1"'];
        case Read.Boolean:
            return ['TRUE', 'FALSE'];
        default:
            return ['1', '"abc"', 'TRUE'];
    }
}

// Evaluates formulas side by side on one sheet, each in its own cell of column N on.
function evaluateAll(formulas: readonly string[]) {
    const cells: Record<string, string> = {};
    formulas.forEach((formula, at) => {
        cells[`N${at + 1}`] = formula;
    });
    const engine = engineOf({ s1: { ...SHEET, ...cells } });
    engine.recalc(Number.POSITIVE_INFINITY);
    return formulas.map((_, at) => valueAt(engine, `N${at + 1}`));
}

function written(entry: Entry, args: readonly string[]): string {
    return `=${entry.name}(${args.join(',')})`;
}

function isFailure(value: unknown): value is FormulaError {
    return typeof value === 'object' && value !== null;
}

// The first argument list from the pools, or from BASES, whose call answers a value.
function baseOf(entry: Entry): readonly string[] | undefined {
    const tries: (readonly string[])[] = [];
    if (BASES[entry.name] !== undefined) tries.push(BASES[entry.name]);
    for (let k = 0; k < 4; k += 1) {
        tries.push(entry.params.map((param, at) => pool(param)[(k + at * k) % pool(param).length]));
    }
    const values = evaluateAll(tries.map((args) => written(entry, args)));
    return tries[values.findIndex((value) => !isFailure(value) || ERRORS.has(entry.name))];
}

const BASE = new Map(ROWS.map((entry) => [entry.name, baseOf(entry)]));

function withArg(args: readonly string[], at: number, put: string): string[] {
    return args.map((arg, i) => (i === at ? put : arg));
}

describe.each(ROWS.map((entry) => [entry.name, entry] as const))('%s', (_name, entry) => {
    const base = BASE.get(entry.name) ?? [];
    const { params } = entry;
    const scalars = params.map((param, at) => (param.prepare === Prepare.Scalar ? at : -1)).filter((at) => at >= 0);
    // The parameters whose reading an error ends.
    const failing = scalars.filter((at) => params[at].read < Read.Any);

    test('has a call that answers a value', () => {
        expect(BASE.get(entry.name)).toBeDefined();
    });

    test('the count of its arguments is checked', () => {
        const formulas: string[] = [];
        if (entry.min > 0) formulas.push(written(entry, base.slice(0, entry.min - 1)));
        if (entry.max < 255) formulas.push(written(entry, [...base, ...base, '1'].slice(0, entry.max + 1)));
        for (const value of evaluateAll(formulas)) expect(value).toBe(VALUE);
        const fewest = evaluateAll([written(entry, base.slice(0, entry.min))])[0];
        expect(fewest).not.toBe(VALUE);
    });

    test('a text that is no value of the reading is #VALUE!, one that is reads as the value', () => {
        for (const at of failing) {
            const { read } = params[at];
            if (read === Read.Text) continue;
            const good = read === Read.Boolean ? ['"true"', 'TRUE'] : ['"2"', '2'];
            const [bad, text, plain] = evaluateAll(
                ['"x y"', ...good].map((put) => written(entry, withArg(base, at, put))),
            );
            expect(bad).toBe(VALUE);
            expect(text).toEqual(plain);
        }
    });

    test('a whole number is cut toward zero', () => {
        for (const at of scalars.filter((slot) => params[slot].read === Read.Integer)) {
            const pairs = [
                ['1.9', '1'],
                ['-0.5', '0'],
                ['-1.5', '-1'],
            ].flat();
            const values = evaluateAll(pairs.map((put) => written(entry, withArg(base, at, put))));
            for (let i = 0; i < values.length; i += 2) expect(values[i]).toEqual(values[i + 1]);
        }
    });

    test('of two errors the one in the earlier argument is the result', () => {
        const formulas: string[] = [];
        for (const first of failing) {
            formulas.push(written(entry, withArg(base, first, '1/0')));
            for (const second of scalars) {
                if (second > first) formulas.push(written(entry, withArg(withArg(base, first, '1/0'), second, 'NA()')));
            }
        }
        for (const value of evaluateAll(formulas)) expect(value).toBe(DIV0);
    });

    test('an array where one value is read gives the answers of one call per element', () => {
        for (const at of scalars) {
            const [a, b] = [pool(params[at])[0], pool(params[at])[1]];
            const lifted = written(entry, withArg(base, at, `{${a},${b},"x y"}`)).slice(1);
            const formulas = [1, 2, 3].map((column) => `=INDEX(${lifted},1,${column})`);
            for (const put of [a, b, '"x y"']) formulas.push(written(entry, withArg(base, at, put)));
            const values = evaluateAll(formulas);
            expect(values.slice(0, 3)).toEqual(values.slice(3));
        }
    });

    test('arrays of unequal length leave #N/A past the end of the shorter', () => {
        if (scalars.length < 2) return;
        const [first, second] = scalars;
        const [a, b] = [pool(params[first])[0], pool(params[second])[0]];
        const wide = withArg(withArg(base, first, `{${a},${a}}`), second, `{${b},${b},${b}}`);
        const [past, same] = evaluateAll([
            `=INDEX(${written(entry, wide).slice(1)},1,3)`,
            written(entry, withArg(withArg(base, first, 'NA()'), second, b)),
        ]);
        expect(past).toEqual(same);
        if (params[first].read < Read.Any) expect(past).toBe(NA);
    });

    test('left out, empty and blank: the default, a blank that is read, a blank that is read', () => {
        for (const at of scalars) {
            const param = params[at];
            const upTo = base.slice(0, at);
            const [blank, empty, cell] = evaluateAll([
                written(entry, [...upTo, 'IF(TRUE,)']),
                written(entry, [...upTo, '']),
                written(entry, [...upTo, 'Z9']),
            ]);
            if (at < entry.min - 1 || (at >= entry.min && at < params.length - 1 && !params[at + 1].optional)) continue;
            // One empty argument alone is a call of no arguments.
            if (at > 0) expect(empty).toEqual(blank);
            expect(cell).toEqual(blank);
            if (!param.optional || param.fallback === undefined || at !== params.length - 1) continue;
            const fallback =
                typeof param.fallback === 'string' ? `"${param.fallback}"` : String(param.fallback).toUpperCase();
            const [left, given] = evaluateAll([written(entry, upTo), written(entry, [...upTo, fallback])]);
            expect(left).toEqual(given);
        }
    });

    test('a number far too large is answered, and no answer is a number a cell cannot hold', () => {
        const formulas = [written(entry, base)];
        for (const at of scalars.filter((slot) => params[slot].read <= Read.Integer)) {
            for (const huge of ['2^31', '1E15', '-1E15', '1E308'])
                formulas.push(written(entry, withArg(base, at, huge)));
        }
        const started = performance.now();
        for (const value of evaluateAll([...formulas, ...formulas])) {
            if (typeof value === 'number') expect(Number.isFinite(value) && !Object.is(value, -0)).toBe(true);
            if (typeof value === 'string') expect(value.length).toBeLessThanOrEqual(32767);
        }
        expect(performance.now() - started).toBeLessThan(2000);
    });

    test('equal arguments give equal answers', () => {
        const [first, second, third] = evaluateAll([written(entry, base), written(entry, base), written(entry, base)]);
        expect(second).toEqual(first);
        expect(third).toEqual(first);
    });
});
