import { describe, expect, test } from 'bun:test';
import { Element, Errors, TypedText } from '../../eval/families';
import type { Entry, Param } from '../../eval/signature';
import { Prepare, Read } from '../../eval/signature';
import { FUNCTIONS } from '../../functions/library';
import { fn, NUMBER, NUMBERS, NUMBERS_A, rest } from '../../functions/registry';
import type { FormulaError } from '../../index';
import { DIV0, NA, NUM, REF, VALUE } from '../../index';
import type { Cells } from '../recalc/support';
import { valuesWith } from '../recalc/support';

// Every law below is derived from a row's own data, for every row of the one table: no law names a function.
// A1:A5 = 10..50, B1:B5 = a..e, C1:C3 = 1, 2, 3, D1 = TRUE, E1:E3 = 1, #DIV/0!, 3, F1:F3 = 1, #N/A, 3, G1:G3 = #N/A, 2,
// 3, Z9 is blank.
const SHEET: Cells = {
    ...{ A1: 10, A2: 20, A3: 30, A4: 40, A5: 50 },
    ...{ B1: 'a', B2: 'b', B3: 'c', B4: 'd', B5: 'e' },
    ...{ C1: 1, C2: 2, C3: 3, D1: true },
    ...{ E1: 1, E2: '=1/0', E3: 3, F1: 1, F2: '=NA()', F3: 3, G1: '=NA()', G2: 2, G3: 3 },
};

// Rows of this test's own, for what no function of this build does yet: a family that reads a text in a cell,
// and a parameter that takes every value before one that takes a single value.
const OWN = [
    fn('MAXA', [rest(NUMBERS_A)], (numbers) => (numbers.count() === 0 ? 0 : numbers.max())),
    fn('LARGE', [NUMBERS, NUMBER], (numbers, k) => numbers.list().sort()[numbers.count() - Math.ceil(k)] ?? NUM),
];
const ROWS = [...FUNCTIONS.values(), ...OWN];

// A row for which no call from the pools answers a value names one here.
const BASES: Readonly<Record<string, readonly string[]>> = {
    XMATCH: ['20', 'A1:A5', '0', '1'],
    AVERAGEIFS: ['A1:A5', 'A1:A5', '">5"'],
    CELL: ['"row"', 'A2'],
    FORMULATEXT: ['E2'],
    INDIRECT: ['"A1"', 'TRUE'],
    MODE: ['{5,5,1,0}'],
    'MODE.SNGL': ['{5,5,1,0}'],
};
// The rows whose answer is an error by definition.
const ERRORS = new Set(['NA', 'INFO']);

// What can be written for a parameter, by its reading: values every reading of that kind takes.
function pool(param: Param<unknown>): readonly string[] {
    // What follows the code of a row that picks another is read by the row that is picked: a range serves each.
    if (param.prepare === Prepare.Reference && param.read === Read.Any) return ['A1:A5', 'C1:C3'];
    switch (param.read) {
        case Read.Number:
        case Read.Integer:
            return ['1', '2', '0.5', '10'];
        case Read.Text:
            return ['"abc"', '"1"'];
        case Read.Boolean:
            return ['TRUE', 'FALSE'];
        case Read.Walked:
            return ['A1:A5', 'C1:C3', '1'];
        case Read.Texts:
            return ['A1:A5', '"abc"', 'B1:B5'];
        case Read.Wholes:
            return ['A1:A5', 'C1:C3', '4'];
        case Read.Pairs:
            return ['A1:A5', 'C1:C3'];
        case Read.Plain:
            return ['20', '10', '"b"'];
        case Read.Table:
            return ['A1:B5', 'A1:A5', 'A1:E1'];
        case Read.Here:
            return ['A2', 'C1:C3'];
        case Read.Only:
            return ['A1:A5', 'C1:C3'];
        default:
            return ['1', '"abc"', 'TRUE'];
    }
}

// Evaluates formulas side by side on one sheet, each in its own cell of column N on.
function together(formulas: readonly string[]) {
    const cells: Record<string, string> = {};
    formulas.forEach((formula, at) => {
        cells[`N${at + 1}`] = formula;
    });
    return valuesWith(OWN, { ...SHEET, ...cells }, Object.keys(cells));
}

// Each formula in a pass of its own, so every one of them starts from the same draw.
function apart(formulas: readonly string[]) {
    return formulas.map((formula) => together([formula])[0]);
}

// The formulas computed one after the other in one pass: each reads the one before it, then makes its own call.
function inTurn(formulas: readonly string[]) {
    return together(
        formulas.map((formula, at) =>
            at === 0 ? formula : `=IF(ISERROR(N${at}),${formula.slice(1)},${formula.slice(1)})`,
        ),
    );
}

function written(entry: Entry, args: readonly string[]): string {
    return `=${entry.name}(${args.join(',')})`;
}

function isFailure(value: unknown): value is FormulaError {
    return typeof value === 'object' && value !== null;
}

// The first argument list from the pools, or from BASES, whose call answers a value.
function baseOf(entry: Entry): readonly string[] | undefined {
    const taken = entry.slots;
    const tries: (readonly string[])[] = [];
    if (BASES[entry.name] !== undefined) tries.push(BASES[entry.name]);
    for (let k = 0; k < 4; k += 1) {
        tries.push(taken.map((param, at) => pool(param)[(k + at * k) % pool(param).length]));
    }
    const values = together(tries.map((args) => written(entry, args)));
    return tries[values.findIndex((value) => !isFailure(value) || ERRORS.has(entry.name))];
}

const BASE = new Map(ROWS.map((entry) => [entry.name, baseOf(entry)]));

function withArg(args: readonly string[], at: number, put: string): string[] {
    return args.map((arg, i) => (i === at ? put : arg));
}

describe.each(ROWS.map((entry) => [entry.name, entry] as const))('%s', (_name, entry) => {
    const base = BASE.get(entry.name) ?? [];
    const params = entry.slots;
    const scalars = params.map((param, at) => (param.prepare === Prepare.Scalar ? at : -1)).filter((at) => at >= 0);
    // The parameters whose reading an error ends, and those read as a number or a truth value.
    const ends = (param: Param<unknown>) =>
        param.read < Read.Anything && (param.family === null || param.family.errors === Errors.Result);
    const failing = params.map((param, at) => (ends(param) ? at : -1)).filter((at) => at >= 0);
    const corners = params.map((param, at) => (param.prepare === Prepare.Corner ? at : -1)).filter((at) => at >= 0);
    const coerced = scalars.filter((at) => params[at].read <= Read.Boolean && params[at].read !== Read.Text);
    // Two calls of a row that draws answer alike only when each is the first call of its pass.
    const evaluateAll = entry.volatile ? apart : together;

    test('has a call that answers a value', () => {
        expect(BASE.get(entry.name)).toBeDefined();
    });

    test('the count of its arguments is checked', () => {
        const formulas: string[] = [];
        if (entry.min > 0) formulas.push(written(entry, base.slice(0, entry.min - 1)));
        if (entry.max < 255) formulas.push(written(entry, [...base, ...base, '1'].slice(0, entry.max + 1)));
        for (const value of evaluateAll(formulas)) expect(value).toBe(VALUE);
        // A group that is not whole, where the row takes no argument after its groups.
        const whole = entry.slots.length === entry.fixed + entry.group;
        if (entry.group > 1 && whole) {
            expect(evaluateAll([written(entry, [...base, base[entry.fixed]])])[0]).toBe(VALUE);
        }
        const fewest = evaluateAll([written(entry, base.slice(0, entry.min))])[0];
        // A row that answers #VALUE! whatever it is given cannot show that its count was accepted.
        if (!ERRORS.has(entry.name)) expect(fewest).not.toBe(VALUE);
    });

    test('a text that is no value of the reading is #VALUE!, one that is reads as the value', () => {
        for (const at of coerced) {
            const { read } = params[at];
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
            for (const second of failing) {
                if (second > first) formulas.push(written(entry, withArg(withArg(base, first, '1/0'), second, 'NA()')));
            }
        }
        for (const value of evaluateAll(formulas)) expect(value).toBe(DIV0);
    });

    // Of a row that draws, the calls are made one after the other, in the order the elements are written.
    test('an array where one value is read gives the answers of one call per element', () => {
        for (const at of [...scalars, ...corners]) {
            const [a, b] = [pool(params[at])[0], pool(params[at])[1]];
            const lifted = written(entry, withArg(base, at, `{${a},${b},"x y"}`)).slice(1);
            const elements = [1, 2, 3].map((column) => `=INDEX(${lifted},1,${column})`);
            const calls = [a, b, '"x y"'].map((put) => written(entry, withArg(base, at, put)));
            expect(evaluateAll(elements)).toEqual(entry.volatile ? inTurn(calls) : evaluateAll(calls));
        }
    });

    test('a call that is an argument is made once, however often its answer is repeated', () => {
        const repeated = `IF({1,1,1},${written(entry, base).slice(1)})`;
        const [once, ...elements] = apart([
            written(entry, base),
            ...[1, 2, 3].map((at) => `=INDEX(${repeated},1,${at})`),
        ]);
        expect(elements).toEqual([once, once, once]);
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
            expect(cell).toEqual(blank);
            // An empty argument is a blank that is read, or left out where the parameter says so.
            if (param.skips && at === params.length - 1) expect(empty).toEqual(evaluateAll([written(entry, upTo)])[0]);
            else if (!param.skips && at > 0) expect(empty).toEqual(blank);
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
        const [first, second, third] = together([written(entry, base), written(entry, base), written(entry, base)]);
        // A row that draws answers anew at each call, with a value of one kind.
        if (entry.volatile && entry.params.some((param) => param.read === Read.Random)) {
            expect(typeof second).toBe(typeof first);
            return;
        }
        expect(second).toEqual(first);
        expect(third).toEqual(first);
    });

    // The parameter that takes every value of its arguments, typed ones too, when the row ends in one.
    const last = entry.params.at(-1);
    const family = last?.rest === true && !last.only ? last.family : undefined;
    // What the call answers with one more argument, and whether two forms of that argument answer alike.
    const same = (a: string, b: string | null) => {
        const [first, second] = evaluateAll([
            written(entry, [...base, a]),
            written(entry, b === null ? base : [...base, b]),
        ]);
        expect(first).toEqual(second);
    };
    const equals = (a: string, expected: FormulaError) =>
        expect(evaluateAll([written(entry, [...base, a])])[0]).toBe(expected);

    test('a value typed where every value is taken is read by the family', () => {
        if (family === undefined || family === null) return;
        same('TRUE', '1');
        same('FALSE', '0');
        if (typeof family.empty === 'object') {
            equals('', family.empty);
            equals('IF(TRUE,)', family.empty);
        } else {
            same('', family.empty ? '0' : null);
            same('IF(TRUE,)', family.empty ? '0' : null);
        }
        if (family.text === TypedText.Parsed) equals('"x y"', VALUE);
        if (family.text === TypedText.Parsed || family.text === TypedText.Numeric) same('"2"', '2');
        if (family.text === TypedText.Numeric || family.text === TypedText.Spelled) same('"x y"', null);
        if (family.text === TypedText.Passed) same('"1"', null);
        if (family.text === TypedText.Passed) same('"x y"', null);
        if (family.text === TypedText.Counted) same('"x y"', '1');
        if (family.text === TypedText.Spelled) same('"true"', 'TRUE');
        if (family.errors === Errors.Result) equals('1/0', DIV0);
        else same('1/0', family.errors === Errors.Counted ? '1' : null);
    });

    test('a cell counts by its kind, a blank cell never, a blank element of an array as a 0', () => {
        if (family === undefined || family === null) return;
        const counts = (kind: number) => ((family.kinds >> kind) & 1) === 1;
        same('D1', counts(2) ? 'TRUE' : null);
        same('B1', counts(3) ? '0' : null);
        // One blank cell by itself is an argument left empty to a family that refuses one.
        if (typeof family.empty === 'object') equals('Z9', family.empty);
        else same('Z9', null);
        same('Z9:Z10', null);
        same('C1', '1');
        same('+D1', 'TRUE');
        same('IF({1,1},Z9:AA9)', '{0,0}');
        same('A1:A40*1', `{10;20;30;40;50${';0'.repeat(35)}}`);
    });

    // A1:A3 are numbers, which every family counts, and D1 is a boolean, which a family counts or not as a cell.
    test('an element of an array that is a reference is what the row says', () => {
        if (family === undefined || family === null) return;
        const { element } = family;
        if (typeof element === 'object') {
            equals('OFFSET(A1,{0,1,2},0,2)', element);
            equals('OFFSET(Z9,{0,1},0,2)', element);
        } else if (element === Element.First) {
            same('OFFSET(A1,{0,1,2},0,2)', 'A1:A3');
            same('OFFSET(D1,{0,0},0,2)', 'D1,D1');
            same('OFFSET(Z9,{0,1},0,2)', null);
        } else {
            same('OFFSET(A1,{0,1,2},0,2)', element === Element.Counted ? '1,1,1' : null);
            same('OFFSET(Z9,{0,1},0,2)', element === Element.Counted ? '1,1' : null);
        }
    });

    test('an error in a range is found in argument order, after every typed argument is read', () => {
        if (family === undefined || family === null) return;
        if (family.errors !== Errors.Result) {
            same('E1:E3', family.errors === Errors.Counted ? '{1,1,1}' : '{1,1}');
            return;
        }
        equals('E1:E3', DIV0);
        equals('E1:E3,F1:F3', DIV0);
        equals('F1:F3,E1:E3', NA);
        equals('E1:E3,NA()', NA);
        if (family.text === TypedText.Parsed) equals('E1:E3,"x y"', VALUE);
    });

    test('an array where every value is taken does not lift the call, and a union gives every area', () => {
        if (family === undefined || family === null) return;
        const whole = written(entry, [...base, '{1,2,3}']).slice(1);
        expect(evaluateAll([`=INDEX(${whole},1,2)`])[0]).toBe(REF);
        if (last?.union === null) same('(A1:A3,C1:C3)', 'A1:A3,C1:C3');
        else if (last !== undefined) equals('(A1:A3,C1:C3)', last.union);
    });

    test('where every value is taken as a text, each is spelled, a range row by row, and nothing lifts', () => {
        if (last?.rest !== true || last.read !== Read.Texts) return;
        same('TRUE', '"TRUE"');
        same('1.5', '"1.5"');
        same('', '""');
        same('IF(TRUE,)', '""');
        same('Z9', '""');
        same('D1', '"TRUE"');
        same('A1:B2', '10,"a",20,"b"');
        same('{1,2;3,4}', '1,2,3,4');
        same('A1:A8*1', '10,20,30,40,50,0,0,0');
        equals('E1:E3', DIV0);
        equals('E1:E3,F1:F3', DIV0);
        equals('F1:F3,E1:E3', NA);
        equals('E1:E3,NA()', NA);
        // An element that is a reference is refused, where a family of numbers reads its first cell.
        equals('INDEX(A1:A5,{2,4})', VALUE);
        const whole = written(entry, [...base, '{1,2,3}']).slice(1);
        expect(evaluateAll([`=INDEX(${whole},1,2)`])[0]).toBe(REF);
    });

    test('where every value is a whole number, a text is read as one, a boolean is refused and a blank passed over', () => {
        if (last?.rest !== true || last.read !== Read.Wholes) return;
        same('"2"', '2');
        same('', null);
        same('IF(TRUE,)', null);
        same('Z9', null);
        same('Z9:Z10', null);
        same('{"2",3}', '2,3');
        same('A1:A2', '10,20');
        equals('TRUE', VALUE);
        equals('D1', VALUE);
        equals('{1,TRUE}', VALUE);
        equals('"x y"', VALUE);
        equals('B1', VALUE);
        equals('E1:E3', DIV0);
        equals('F1:F3,E1:E3', NA);
        equals('E1:E3,NA()', NA);
        equals('(A1:A3,C1:C3)', VALUE);
        equals('INDEX(A1:A5,{2,4})', VALUE);
        const whole = written(entry, [...base, '{1,2,3}']).slice(1);
        expect(evaluateAll([`=INDEX(${whole},1,2)`])[0]).toBe(REF);
    });

    test('two ranges side by side pair by place, leave out a pair with no number, and answer the earliest error', () => {
        const at = params.findIndex((param) => param.read === Read.Pairs);
        if (at < 0) return;
        const both = (first: string, second: string) =>
            written(entry, withArg(withArg(base, at, first), at + 1, second));
        const values = evaluateAll([
            both('A1:A5', 'C1:C3'),
            both('A1:A4', '{2,4}'),
            both('E1:E3', 'G1:G3'),
            both('G1:G3', 'E1:E3'),
            both('E1:E3', 'F1:F3'),
            both('F1:F3', 'E1:E3'),
            both('A1:A5', ''),
            both('A1:A6', 'A1:C2'),
            both('{10;30;40}', '{10;1;20}'),
            both('A1:C6', 'A1:C6'),
            both('{10;20;30;40;50}', '{10;20;30;40;50}'),
            both('A1:A5', 'INDEX(A1:A5,{1;2;3;4;5})'),
            both('{10;20}', '{10;20}'),
            both('A1:A2', 'A1:A2'),
        ]);
        expect(values.slice(0, 7)).toEqual([NA, NA, NA, NA, DIV0, NA, VALUE]);
        expect(values[7]).toEqual(values[8]);
        expect(values[9]).toEqual(values[10]);
        // An element that is a reference is no number, so its pair is left out.
        expect(values[11]).toEqual(evaluateAll([both('{"a";"b"}', '{1;2}')])[0]);
        expect(values[12]).toEqual(values[13]);
    });

    test('a union of areas answers what the parameter says', () => {
        const formulas: string[] = [];
        const expected: FormulaError[] = [];
        params.forEach((param, at) => {
            if (param.union === null || param.family !== null) return;
            formulas.push(written(entry, withArg(base, at, '(A1:A3,C1:C3)')));
            expected.push(param.union);
        });
        expect(evaluateAll(formulas)).toEqual(expected);
    });

    test('where the first cell is read, a range is one value and an array of references one value per reference', () => {
        for (const at of corners) {
            const put = (argument: string) => written(entry, withArg(base, at, argument));
            const [cell, other, range, union, second, ...lifted] = evaluateAll([
                put('A2'),
                put('A4'),
                put('A2:B4'),
                put('(A2:A3,C1:C3)'),
                `=INDEX(${put('A2:A4').slice(1)},2,1)`,
                `=INDEX(${put('INDEX(A1:A5,{2,4})').slice(1)},1,1)`,
                `=INDEX(${put('INDEX(A1:A5,{2,4})').slice(1)},1,2)`,
            ]);
            expect([range, union, second]).toEqual([cell, cell, REF]);
            expect(lifted).toEqual([cell, other]);
        }
    });

    test('where a range is taken cell by cell, it gives one answer per cell, and of a union the first area', () => {
        for (const at of params.map((param, i) => (param.apiece ? i : -1))) {
            if (at < 0) continue;
            const put = (argument: string) => written(entry, withArg(base, at, argument));
            const [cell, other, ...lifted] = evaluateAll([
                put('E2'),
                put('F1'),
                `=INDEX(${put('E1:F2').slice(1)},2,1)`,
                `=INDEX(${put('(E1:E2,A1:A5)').slice(1)},2,1)`,
                `=INDEX(${put('E1:F2').slice(1)},1,2)`,
                `=INDEX(${put('E1:E2').slice(1)},3,1)`,
            ]);
            expect(lifted).toEqual([cell, cell, other, REF]);
        }
    });

    test('where only a reference is taken, an array of references gives one answer per reference', () => {
        for (const at of params.map((param, i) => (param.prepare === Prepare.Reference ? i : -1))) {
            if (at < 0) continue;
            const lifted = written(entry, withArg(base, at, 'INDEX(A1:A5,{2,4})')).slice(1);
            const values = evaluateAll([
                `=INDEX(${lifted},1,1)`,
                `=INDEX(${lifted},1,2)`,
                written(entry, withArg(base, at, 'A2')),
                written(entry, withArg(base, at, 'A4')),
                written(entry, withArg(base, at, '{1,2}')),
            ]);
            expect(values.slice(0, 2)).toEqual(values.slice(2, 4));
            expect(values[4]).toBe(VALUE);
        }
    });
});
