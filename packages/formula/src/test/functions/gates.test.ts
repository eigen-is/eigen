import { describe, expect, test } from 'bun:test';
import type { Book } from '../../eval/book';
import { Fact, shapeFacts } from '../../eval/facts';
import { Families } from '../../eval/families';
import type { Matches, Room } from '../../eval/readers';
import type { Vector } from '../../eval/search';
import type { Entry } from '../../eval/signature';
import { Read, TOKENS } from '../../eval/signature';
import { FUNCTIONS } from '../../functions/library';
import type { Numbers, Pairs, Table } from '../../functions/registry';
import {
    ANYTHING,
    BOOLEAN,
    defaulted,
    ENGINE,
    each,
    Find,
    fn,
    INTEGER,
    LAZY,
    MATCHED,
    NEXT,
    NUMBER,
    NUMBERS,
    optional,
    PAIRS,
    refusing,
    rest,
    TABLE,
    TEXT,
    TEXTS,
    WHERE,
} from '../../functions/registry';
import { Recalc } from '../../recalc/recalc';
import { Workbook } from '../../store/workbook';
import { parseA1 } from '../../text';
import { NA } from '../../values/errors';
import { rectangle } from '../../values/rectangle';
import { ValueType } from '../../values/value';
import { at, evaluateWith, stored } from '../recalc/support';

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
        expect(recalc.pass(Number.POSITIVE_INFINITY)).toMatchObject({ loops: [], stopped: false });
        expect([value('B1'), value('B2'), value('B3')]).toEqual([2, 4, 8]);
    });
});

describe('a union is refused where the row says so, by a family too', () => {
    test('a family that may be left out refuses a union with the error it is given', () => {
        const row = fn('DAYS2', [NUMBER, optional(refusing(NUMBERS, NA))], (first, rest) => first + rest.count());
        const cells = { A1: 1, A2: 2, N1: '=DAYS2(1,(A1,A2))', N2: '=DAYS2(1,A1:A2)', N3: '=DAYS2(1)' };
        const { recalc, value } = passOf(row, cells);
        recalc.pass(Number.POSITIVE_INFINITY);
        expect(['N1', 'N2', 'N3'].map(value)).toEqual([NA, 3, 1]);
    });
});

describe('a body reaches no cell, column or stored array', () => {
    // Checked when the tests are compiled: a member of Vector that is not listed here is one a body could read.
    test('of a row or a column of a table it gets the two searches and nothing else', () => {
        const reachable: Record<keyof Vector, true> = { find: true, seek: true };
        expect(Object.keys(reachable)).toEqual(['find', 'seek']);
    });

    // Checked when the tests are compiled, as above: each list is every member a body can name on a reader.
    test('of each reader it gets what the reader hands out, and nothing that aims it', () => {
        const table: Record<keyof Table, true> = {
            ...{ type: true, rows: true, columns: true, areas: true, reference: true },
            ...{ area: true, column: true, row: true, at: true, part: true },
        };
        const numbers: Record<keyof Numbers, true> = {
            ...{ sum: true, count: true, min: true, max: true, list: true, holds: true },
        };
        const pairs: Record<keyof Pairs, true> = { xs: true, ys: true };
        const matches: Record<keyof Matches, true> = { count: true };
        const room: Record<keyof Room, true> = { series: true };
        const book: Record<keyof Book, true> = {
            ...{ formula: true, value: true, elsewhere: true, sheets: true, refer: true },
        };
        expect([table, numbers, pairs, matches, room, book].map((members) => Object.keys(members).length)).toEqual([
            10, 6, 2, 1, 1, 5,
        ]);
    });

    // Checked when the tests are compiled: a book is asked about the cell its row names, and about no other.
    test('a body that asks the book about a cell of its choice, or keeps a reference it read, does not compile', () => {
        const rows = [
            // @ts-expect-error a book has no member that takes a place
            fn('PEEK', [INTEGER, ENGINE], (row, book) => book.value(rectangle(0, row, 0, row, 0))),
            // @ts-expect-error nor one that takes a place for a formula
            fn('PEEK', [INTEGER, ENGINE], (row, book) => book.formula(rectangle(0, row, 0, row, 0)) ?? 0),
            // @ts-expect-error the evaluator behind it is not a body's to reach
            fn('PEEK', [ENGINE], (book) => book.ctx.recalc.valueOf(book.ctx.workbook.sheets[0], 9, 9)),
            // @ts-expect-error a reference read from a text is handed back only by a row that is marked for it
            fn('PEEK', [TEXT, ENGINE], (text, book) => book.refer(text, true)),
            // @ts-expect-error by a key in brackets neither: what a book holds is no property of it
            fn('PEEK', [ENGINE], (book) => book['ctx'].recalc.valueOf(book['ctx'].workbook.sheets[0], 9, 9)),
        ];
        expect(rows.length).toBe(5);
    });

    // A row on this list can answer anew with no value changed, so each is computed in every pass that has a write.
    test('the rows that ask the workbook are these six, and a formula that calls one reads cells it does not name', () => {
        const asking = [...FUNCTIONS.values()].filter((entry) =>
            entry.params.some((param) => param.read === Read.Engine),
        );
        expect(asking.map((entry) => entry.name).sort()).toEqual([
            ...['CELL', 'FORMULATEXT', 'INDIRECT', 'ISFORMULA', 'SHEET', 'SHEETS'],
        ]);
        for (const entry of asking) {
            const tree = parseA1(`=1+${entry.name}(A1)`, 0, 0, () => undefined);
            expect('reason' in tree ? 0 : shapeFacts(tree, FUNCTIONS) & Fact.ReadsUnnamed).toBe(Fact.ReadsUnnamed);
        }
        const plain = parseA1('=1+ISREF(A1)', 0, 0, () => undefined);
        expect('reason' in plain ? -1 : shapeFacts(plain, FUNCTIONS) & Fact.ReadsUnnamed).toBe(0);
    });

    // Checked when the tests are compiled: each of these bodies would read a cell its row does not name.
    test('a body that aims a reader at a cell of its choice does not compile', () => {
        const rows = [
            fn('PEEK', [TABLE, INTEGER, INTEGER], (table, row, column) =>
                // @ts-expect-error a table has no member that takes a place
                table.over(rectangle(0, row, column, row, column)).at(0, 0),
            ),
            // @ts-expect-error a reader of numbers has no member that takes arguments
            fn('GRAB', [rest(NUMBERS)], (numbers) => numbers.together(0, 2).sum()),
            // @ts-expect-error nor one that takes a family
            fn('GRAB', [rest(NUMBERS)], (numbers) => numbers.bind(0, 2, Families.Counted, true).sum()),
            // @ts-expect-error nor one that takes what the criteria of another call left
            fn('GRAB', [rest(NUMBERS)], (numbers) => numbers.beside().sum()),
            // @ts-expect-error two ranges side by side have no member that takes other ranges
            fn('GRAB', [PAIRS], (pairs) => pairs.over(rectangle(0, 0, 0, 9, 0), rectangle(0, 0, 1, 9, 1)) ?? 0),
        ];
        expect(rows.length).toBe(5);
    });

    // J10 is named by no argument: a place outside the table is #N/A, and a row or column outside it holds nothing.
    test('a table hands out no cell outside it, whatever a body asks it for', () => {
        const peek = fn('PEEK', [TABLE, INTEGER, INTEGER], (table, row, column) => {
            table.rows = 100;
            table.columns = 100;
            const found = [table.column(column).find(777, Find.Exact), table.row(row).find(777, Find.Exact)];
            return found[0] >= 0 || found[1] >= 0 ? 'found' : table.at(row, column);
        });
        const cells = { A1: 1, J10: 777, A10: 777, J1: 777, N1: '=PEEK(A1,9,9)', N2: '=PEEK(A1:B2,9,9)' };
        const { recalc, value } = passOf(peek, { ...cells, N3: '=PEEK({1,2;3,4},9,9)', N4: '=PEEK(A1:B2,-1,-1)' });
        recalc.pass(Number.POSITIVE_INFINITY);
        expect(['N1', 'N2', 'N3', 'N4'].map(value)).toEqual([NA, NA, NA, NA]);
    });
});

describe('what a modifier says of the type is what the body gets', () => {
    // Checked when the tests are compiled: the list is no `| undefined`, as it is none when the body runs.
    test('a list that repeats and may be left out is a list still', () => {
        const row = fn('JOINED', [optional(rest(TEXTS))], (texts) => texts.join('+'));
        expect(evaluateWith([row], '=JOINED()&JOINED("a",1)')).toBe('a+1');
    });

    test('a default for an argument left empty must be a value of the reading', () => {
        expect(() => fn('WRONG', [defaulted(BOOLEAN, true), rest(TEXTS)], () => 0)).not.toThrow();
        const wrong = Object.freeze({ ...BOOLEAN, skips: true, fallback: 'x' });
        expect(() => fn('WRONG', [wrong], () => 0)).toThrow('a fallback of another kind');
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
