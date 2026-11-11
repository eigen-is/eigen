// What the tests of the edit transforms share, such as three sheets, a formula typed at a cell and read back at one,
// edits named as a person names them, the places a reference may stand in, and a seeded generator.

import type { FormulaNode, LineEdit } from '../../text';
import { GRID_COLUMNS, GRID_ROWS, mapIndex, parseA1, parseStored, printA1, printStored, sheetFinder } from '../../text';
import { at } from '../text/support';

export const SHEETS = [
    { id: 's1', name: 'Sheet1' },
    { id: 's2', name: 'Sheet2' },
    { id: 's3', name: 'Sheet3' },
];

const findSheet = sheetFinder(SHEETS);

export function sheetName(id: string): string | undefined {
    return SHEETS.find((sheet) => sheet.id === id)?.name;
}

export function tree(text: string, host: string): FormulaNode {
    const parsed = parseA1(text, ...at(host), findSheet);
    if ('reason' in parsed) throw new Error(`${text}: ${parsed.reason} at ${parsed.at}`);
    return parsed;
}

export function shown(node: FormulaNode, host: string): string {
    return printA1(node, ...at(host), sheetName);
}

// What a transform returns must be text the parser reads back as the same tree: the tree its stored text parses to,
// or why it did not parse, to hold against the tree itself.
export function reread(node: FormulaNode): FormulaNode | string {
    const stored = printStored(node);
    const back = parseStored(stored);
    return 'reason' in back ? `${stored}: ${back.reason}` : back;
}

// Where three references may stand, in either notation: as arguments, and in the places where the #REF! one of them
// becomes must still be an operand, such as a spill, an intersection, a union and a range of ranges.
export const CONTEXTS: ((a: string, b: string, c: string) => string)[] = [
    (a, b, c) => `=SUM(${a},${b},${c})`,
    (a, b, c) => `=${a}#+SUM(${b}#:(${c}))`,
    (a, b, c) => `=SUM(${a} ${b},${c} ${a})`,
    (a, b, c) => `=SUM((${a},${b}) ${c})+ROWS((${c},${a}))`,
    (a, b, c) => `=SUM((${a}):(${b}):(${c}))`,
    (a, b, c) => `=-${a}%+@${b}+SUM(${c}# (${a},${b}))`,
];

// Rows and columns are counted from 1 here, as a person names them: "insert 2 rows at 5".
export const insertRows = (at1: number, count = 1, sheet = 's1'): LineEdit => ({
    insert: true,
    index: at1 - 1,
    count,
    sheet,
    rows: true,
});

export const deleteRows = (from1: number, to1 = from1, sheet = 's1'): LineEdit => ({
    insert: false,
    index: from1 - 1,
    count: to1 - from1 + 1,
    sheet,
    rows: true,
});

export const insertColumns = (label: string, count = 1, sheet = 's1'): LineEdit => ({
    insert: true,
    index: at(`${label}1`)[1],
    count,
    sheet,
    rows: false,
});

export const deleteColumns = (from: string, to = from, sheet = 's1'): LineEdit => ({
    insert: false,
    index: at(`${from}1`)[1],
    count: at(`${to}1`)[1] - at(`${from}1`)[1] + 1,
    sheet,
    rows: false,
});

// Where a line of the edited axis is after the edit, or GONE.
export function lineAfter({ insert, index, count, rows }: LineEdit, line: number): number {
    return mapIndex({ insert, index, count, lines: rows ? GRID_ROWS : GRID_COLUMNS }, line);
}

export function random(seed: number): (below: number) => number {
    let state = seed;
    return (below) => {
        state = (state + 0x6d2b79f5) | 0;
        let t = Math.imul(state ^ (state >>> 15), 1 | state);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return Math.floor((((t ^ (t >>> 14)) >>> 0) / 4294967296) * below);
    };
}

// A seeded writer of typed formulas over a few cells of three sheets, from the grammar and not from the parser, so
// some do not parse. It is rich in what a transform may leave beside an operator that joins references: a sheet on
// either side of a colon, a name, a call, a chain of ranges and whitespace on either side.
export function shapes(pick: (below: number) => number): () => string {
    const one = <T>(list: readonly T[]): T => list[pick(list.length)];
    const space = () => (pick(6) === 0 ? one([' ', '  ', '\n']) : '');
    const dollar = () => (pick(3) === 0 ? '$' : '');
    const column = () => dollar() + 'ABCDEF'[pick(6)];
    const row = () => dollar() + (1 + pick(8));
    const cell = () => column() + row();
    const prefix = () => one(['', '', '', '', 'Sheet1!', 'Sheet2!', "'My Sheet'!", 'Later!']);
    const reference = () =>
        prefix() +
        one([
            cell,
            cell,
            cell,
            () => `${cell()}:${cell()}`,
            () => `${column()}:${column()}`,
            () => `${row()}:${row()}`,
        ])();
    const name = () => one(['Rate', 'x', 'B', 'total_2', 'Sheet2', 'Sheet2!Rate', 'Later!x']);
    const call = (depth: number) =>
        one([
            () => `INDEX(${reference()},${1 + pick(3)})`,
            () => `SUM(${region(depth - 1)},${expression(depth - 1)})`,
            () => `OFFSET(${reference()},1,${space()}1)`,
            () => `IF(${expression(depth - 1)},${region(depth - 1)},)`,
        ])();
    const end = (depth: number): string => {
        const leaves = [reference, reference, reference, cell, name, () => `${reference()}#`, () => '#REF!'];
        if (depth <= 0) return one(leaves)();
        return one([
            ...leaves,
            () => call(depth),
            () => `(${region(depth - 1)}${space()})`,
            () => `(${region(depth - 1)},${region(depth - 1)})`,
            () => `(${end(depth - 1)})#`,
        ])();
    };
    // One to four ends with the `:` operator between them, then perhaps an intersection.
    const region = (depth: number): string => {
        let text = space() + end(depth);
        for (let more = one([0, 0, 1, 1, 1, 2, 3]); more > 0; more -= 1) text += `${space()}:${space()}${end(depth)}`;
        return pick(8) === 0 ? `${text}${one([' ', '  '])}${end(depth)}` : text;
    };
    const operand = (depth: number): string =>
        one([
            () => region(depth),
            () => region(depth),
            () => region(depth),
            () => `${space()}${one(['-', '+', '@'])}${region(depth)}`,
            () => `${region(depth)}${space()}%`,
            () => space() + one(['1', '2.5', '"a"', 'TRUE', '#N/A', '{1,2;3,4}']),
        ])();
    const expression = (depth: number): string => {
        let text = operand(depth);
        while (pick(4) === 0) text += space() + one(['+', '-', '*', '&', '=', '<=']) + operand(depth);
        return text;
    };
    return () => `=${expression(2)}`;
}
