// What a table reference of a file stands for. The reader keeps Sales[[#This Row],[Qty]] as one leaf with its
// brackets as written; here they are read: which rows of the table, and which of its columns. resolveTables is what
// an importer calls with the tables of its file: each reference becomes the plain range it names, and one whose
// table, column or rows the file does not have stays, to answer #REF! and be written back as it was read.

import { mapLeaves } from '../edit/leaves';
import { AT, BRACKET_OPEN, COLON, COMMA, HASH, SPACE } from './chars';
import { lexAt, Token, tokenEnd, tokenKind } from './lexer';
import type { FormulaNode } from './tree';
import { NodeKind, RefFlag, RefKind, referenceNode, SheetKind } from './tree';

export type Table = {
    // The id of its sheet, and its whole rectangle from 0, with the header and totals rows it has.
    readonly sheet: string;
    readonly top: number;
    readonly left: number;
    readonly bottom: number;
    readonly right: number;
    readonly headerRows: number;
    readonly totalsRows: number;
    // The names of its columns from the left, as the file's table part has them, decoded.
    readonly columns: readonly string[];
};

// The table a reference at a cell names, or with no name the table that cell lies in.
export type TableFinder = (name: string, sheet: string, row: number, column: number) => Table | undefined;

const HEADERS = 1;
const DATA = 2;
const TOTALS = 4;
const THIS_ROW = 8;
const ITEMS: ReadonlyMap<string, number> = new Map([
    ['#all', HEADERS | DATA | TOTALS],
    ['#data', DATA],
    ['#headers', HEADERS],
    ['#totals', TOTALS],
    ['#this row', THIS_ROW],
]);

const ESCAPED = /'([\s\S])/g;

// The rows a reference picks, as the bits above, and its first and last column in lower case, both empty for
// every column. Null for brackets that say nothing Excel would read.
type Picked = { readonly rows: number; readonly first: string; readonly last: string };

// The tree with every table reference that `findTable` knows replaced by its range, for a formula at a cell of
// `sheet`. A table's cells do not move with the formula, so the range is absolute, but for the row of this row.
export function resolveTables(
    tree: FormulaNode,
    sheet: string,
    row: number,
    column: number,
    findTable: TableFinder,
): FormulaNode {
    return mapLeaves(tree, (node) => {
        if (node.kind !== NodeKind.Table || node.sheetKind !== SheetKind.Host) return node;
        const picked = pick(node.text);
        const table = picked && findTable(node.text.slice(0, node.text.indexOf('[')), sheet, row, column);
        if (!picked || !table) return node;
        const { rows } = picked;
        const first = picked.first === '' ? 0 : columnOf(table, picked.first);
        const last = picked.first === '' ? table.right - table.left : columnOf(table, picked.last);
        const dataTop = table.top + table.headerRows;
        const dataBottom = table.bottom - table.totalsRows;
        let top = rows & HEADERS ? table.top : rows & DATA ? dataTop : table.bottom;
        let bottom = rows & TOTALS ? table.bottom : rows & DATA ? dataBottom : table.top;
        let flags = RefFlag.ColumnAbsolute | RefFlag.Column2Absolute;
        if (rows === THIS_ROW) {
            // Excel reads this row by the row's number, on any sheet. Outside the table's data rows it answers
            // #VALUE!, and so the reference is left as it is.
            if (row < dataTop || row > dataBottom) return node;
            top = 0;
            bottom = 0;
        } else {
            // #All is the rows the table has. A row asked for by its own name must be there.
            const whole = rows === (HEADERS | DATA | TOTALS);
            if (!whole && rows & HEADERS && table.headerRows === 0) return node;
            if (!whole && rows & TOTALS && table.totalsRows === 0) return node;
            flags |= RefFlag.RowAbsolute | RefFlag.Row2Absolute;
        }
        if (first === -1 || last === -1 || top > bottom) return node;
        const left = table.left + Math.min(first, last);
        const right = table.left + Math.max(first, last);
        const sheetKind = table.sheet === sheet ? SheetKind.Host : SheetKind.Id;
        const id = table.sheet === sheet ? '' : table.sheet;
        return top === bottom && left === right
            ? referenceNode(
                  RefKind.Cell,
                  node.space,
                  sheetKind,
                  id,
                  top,
                  left,
                  0,
                  0,
                  flags & (RefFlag.RowAbsolute | RefFlag.ColumnAbsolute),
              )
            : referenceNode(RefKind.Range, node.space, sheetKind, id, top, left, bottom, right, flags);
    });
}

// Whether a table reference is one cell wherever its table is: this row of one column.
export function isTableCell(node: FormulaNode): boolean {
    const picked = pick(node.text);
    return picked !== null && picked.rows === THIS_ROW && picked.first !== '' && picked.first === picked.last;
}

// Reads the brackets: an @, then one item or column bare, or bracketed parts with commas between and a colon
// between the two columns of a range. Whitespace may stand after the first bracket, before the last and around a
// comma or colon, as Excel allows.
function pick(text: string): Picked | null {
    const end = text.length - 1;
    let at = text.indexOf('[') + 1;
    let rows = 0;
    if (text.charCodeAt(at) === AT) {
        rows = THIS_ROW;
        at += 1;
    }
    let inner = at;
    while (text.charCodeAt(inner) === SPACE) inner += 1;
    const bare = text.charCodeAt(inner) !== BRACKET_OPEN;
    if (!bare) at = inner;
    let first = '';
    let last = '';
    let columns = 0;
    let ranged = false;
    while (at < end) {
        const part = bare ? end << 6 : lexAt(text, at);
        if (!bare && tokenKind(part) !== Token.Bracket) return null;
        const close = bare ? end : tokenEnd(part) - 1;
        const name = text.slice(bare ? at : at + 1, close);
        if (name.charCodeAt(0) === HASH) {
            const item = ITEMS.get(name.toLowerCase());
            if (item === undefined || ranged) return null;
            rows |= item;
        } else {
            if (name === '' || columns > (ranged ? 1 : 0)) return null;
            last = name.replace(ESCAPED, '$1').toLowerCase();
            if (columns === 0) first = last;
            columns += 1;
        }
        at = close + 1;
        while (text.charCodeAt(at) === SPACE) at += 1;
        if (at >= end) break;
        const separator = text.charCodeAt(at);
        ranged = separator === COLON;
        if (ranged ? columns !== 1 : separator !== COMMA) return null;
        at += 1;
        while (text.charCodeAt(at) === SPACE) at += 1;
        if (at >= end) return null;
    }
    if (rows === (HEADERS | TOTALS) || rows > THIS_ROW) return null;
    return { rows: rows === 0 ? DATA : rows, first, last };
}

function columnOf(table: Table, name: string): number {
    for (let i = 0; i < table.columns.length; i += 1) {
        if (table.columns[i].toLowerCase() === name) return i;
    }
    return -1;
}
