import { describe, expect, test } from 'bun:test';
import type { Entry } from '../../eval/signature';
import { TOKENS } from '../../eval/signature';
import { FUNCTIONS } from '../../functions/library';
import type { Vector } from '../../functions/registry';
import {
    ANYTHING,
    each,
    fn,
    LAZY,
    MATCHED,
    NEXT,
    NUMBER,
    NUMBERS,
    optional,
    PAIRS,
    rest,
    TABLE,
    WHERE,
} from '../../functions/registry';
import { Recalc } from '../../recalc/recalc';
import { Workbook } from '../../store/workbook';
import { ValueType } from '../../values/value';
import { at, stored } from '../recalc/support';

// A recalc over typed cells with one more row in the list of functions: what no function of this build does.
function passOf(entry: Entry, cells: Readonly<Record<string, string | number>>) {
    const workbook = new Workbook([
        {
            id: 's1',
            name: 'Sheet1',
            cells: (cell) => {
                for (const [label, input] of Object.entries(cells)) {
                    const [row, column] = at(label);
                    if (typeof input === 'string') cell(row, column, null, stored(input, label));
                    else cell(row, column, input, null);
                }
            },
        },
    ]);
    const recalc = new Recalc(workbook, new Map([...FUNCTIONS, [entry.name, entry]]));
    const value = (label: string) => workbook.value(workbook.sheets[0].columns[at(label)[1]], at(label)[0]);
    return { recalc, value };
}

describe('what a body can do wrong is caught by the wrapper', () => {
    test.each([
        ['a token it made itself', fn('FORGED', [LAZY], () => ({ type: ValueType.Lazy, index: 0 }))],
        ['the token of an argument that is not lazy', fn('FORGED', [LAZY, optional(NUMBER, 0)], () => TOKENS[1])],
        ['the token of no argument', fn('FORGED', [LAZY], () => TOKENS[7])],
        ['NEXT from a row with no groups', fn('FORGED', [LAZY], () => NEXT)],
    ])('a body that answers %s makes the recalc throw', (_what, entry) => {
        const { recalc } = passOf(entry, { A1: '=FORGED(1)' });
        expect(() => recalc.pass(Number.POSITIVE_INFINITY)).toThrow('a foreign token');
    });

    test('a write through the list a body was given changes no cell and no later call', () => {
        const wrote = fn('WROTE', [rest(NUMBER)], (list) => {
            const sum = list[0] + list[1];
            Reflect.set(list, 0, 99);
            return sum;
        });
        const { recalc, value } = passOf(wrote, { A1: 1, A2: 2, B1: '=WROTE(A1,A2)', B2: '=WROTE(A1,A2)+SUM(A1:A2)' });
        recalc.pass(Number.POSITIVE_INFINITY);
        expect([value('A1'), value('A2'), value('B1'), value('B2')]).toEqual([1, 2, 3, 6]);
    });

    test('a write into the list of every number changes no cell, and no later list', () => {
        const wrote = fn('WROTE', [rest(NUMBERS)], (numbers) => {
            const list = numbers.list();
            const first = list[0];
            list.fill(99);
            return first + numbers.list()[0] + numbers.sum();
        });
        const { recalc, value } = passOf(wrote, { A1: 1, A2: 2, B1: '=WROTE(A1:A2)', B2: '=WROTE(A1:A2)+SUM(A1:A2)' });
        recalc.pass(Number.POSITIVE_INFINITY);
        expect([value('A1'), value('A2'), value('B1'), value('B2')]).toEqual([1, 2, 5, 8]);
    });

    test('a body that throws leaves the cells as a recalc that never ran, and the next recalc computes them', () => {
        let fail = true;
        const thrower = fn('THROWER', [NUMBER], (number) => {
            if (fail) throw new Error('a body that throws');
            return number + 1;
        });
        const cells = { A1: 1, B1: '=SUM(A1,1)', B2: '=IF(TRUE,THROWER(B1))+1', B3: '=B2+SUM(THROWER(A1),B1)' };
        const { recalc, value } = passOf(thrower, cells);
        expect(() => recalc.pass(Number.POSITIVE_INFINITY)).toThrow('a body that throws');
        fail = false;
        expect(recalc.pass(Number.POSITIVE_INFINITY)).toEqual({ loops: [], stopped: false });
        expect([value('B1'), value('B2'), value('B3')]).toEqual([2, 4, 8]);
    });
});

describe('a body reaches no cell, column or stored array', () => {
    // Checked when the tests are compiled: a member of Vector that is not listed here is one a body could read.
    test('of a row or a column of a table it gets the two searches and nothing else', () => {
        const reachable: Record<keyof Vector, true> = { find: true, seek: true };
        expect(Object.keys(reachable)).toEqual(['find', 'seek']);
    });
});

describe('a row that is put together wrongly fails when it is made', () => {
    test.each([
        ['a parameter after the criteria', () => fn('WRONG', [WHERE, NUMBER], () => 0)],
        ['numbers beside criteria, and no criteria', () => fn('WRONG', [MATCHED], () => 0)],
        [
            'after the groups, more than one',
            () => fn('WRONG', [each(NUMBER), optional(LAZY, 0), optional(LAZY, 0)], () => 0),
        ],
        ['after the groups, more than one', () => fn('WRONG', [each(NUMBER), NUMBER], () => 0)],
        ['groups tried in turn beside a range', () => fn('WRONG', [NUMBERS, each(NUMBER)], () => 0)],
        ['a parameter after a repeating', () => fn('WRONG', [rest(NUMBER), each(NUMBER)], () => 0)],
        ['a table that repeats', () => fn('WRONG', [rest(TABLE)], () => 0)],
        ['a table that repeats', () => fn('WRONG', [NUMBER, rest(ANYTHING)], () => 0)],
        ['two ranges side by side that repeat or may be left out', () => fn('WRONG', [rest(PAIRS)], () => 0)],
        ['two ranges side by side that repeat or may be left out', () => fn('WRONG', [optional(PAIRS)], () => 0)],
        [
            'two ranges side by side that repeat or may be left out',
            () => fn('WRONG', [NUMBER, optional(PAIRS)], () => 0),
        ],
        [
            'a fallback of another kind',
            () =>
                fn(
                    'WRONG',
                    [optional(NUMBER, 1), optional(NUMBER, 2)]
                        .slice(0, 0)
                        .concat([Object.freeze({ ...NUMBER, optional: true, fallback: 'x' })]),
                    () => 0,
                ),
        ],
    ])('%s', (message, make) => {
        expect(make).toThrow(message);
    });
});
