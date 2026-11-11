// What the tests of the edit transforms share: three sheets, a formula typed at a cell and read back at one, edits
// named as a person names them, and a seeded generator.

import type { FormulaNode, LineEdit } from '../../text';
import { GRID_COLUMNS, GRID_ROWS, parseA1, printA1, sheetFinder } from '../../text';
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

// Rows and columns are counted from 1 here, as a person names them: "insert 2 rows at 5".
export const insertRows = (at1: number, count = 1, sheet = 's1'): LineEdit => ({
    insert: true,
    index: at1 - 1,
    count,
    lines: GRID_ROWS,
    sheet,
    rows: true,
});

export const deleteRows = (from1: number, to1 = from1, sheet = 's1'): LineEdit => ({
    insert: false,
    index: from1 - 1,
    count: to1 - from1 + 1,
    lines: GRID_ROWS,
    sheet,
    rows: true,
});

export const insertColumns = (label: string, count = 1, sheet = 's1'): LineEdit => ({
    insert: true,
    index: at(`${label}1`)[1],
    count,
    lines: GRID_COLUMNS,
    sheet,
    rows: false,
});

export const deleteColumns = (from: string, to = from, sheet = 's1'): LineEdit => ({
    insert: false,
    index: at(`${from}1`)[1],
    count: at(`${to}1`)[1] - at(`${from}1`)[1] + 1,
    lines: GRID_COLUMNS,
    sheet,
    rows: false,
});

export function random(seed: number): (below: number) => number {
    let state = seed;
    return (below) => {
        state = (state + 0x6d2b79f5) | 0;
        let t = Math.imul(state ^ (state >>> 15), 1 | state);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return Math.floor((((t ^ (t >>> 14)) >>> 0) / 4294967296) * below);
    };
}
