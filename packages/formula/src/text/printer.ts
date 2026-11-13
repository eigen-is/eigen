// The two printers over the one tree. printStored writes the canonical shape text, which is what a cell stores and
// what the shape table keys on: offsets in R1C1 notation and sheets by id. printA1 writes what a person reads at a
// given cell, such as in the formula bar: labels, sheet names, corners in order, and #REF! for a reference that
// falls off the grid there or names a sheet that is gone. printXlsx is printA1 without the =, as a file holds it.

import { columnLabel, GRID_COLUMNS, GRID_ROWS } from './a1';
import { ERROR_LITERALS, isWord, SYMBOLS, Token } from './lexer';
import type { ParseFailure } from './parser';
import { MAX_STORED_LENGTH, noSheet, readsAsReference, referenceAt } from './parser';
import { inQuotes, quoteSheetName } from './sheet-name';
import type { Ends, FormulaNode } from './tree';
import { endsAt, NodeKind, RefFlag, RefKind, SheetKind } from './tree';

// The smallest exponent a number below 1 prints in plain digits with, which is about where Excel turns to E notation.
const PLAIN_EXPONENT_MIN = -18;

export type SheetNames = (id: string) => string | undefined;

export function printStored(tree: FormulaNode): string {
    return `=${print(tree, true, 0, 0, noSheet)}`;
}

// The stored text of a formula as it is entered or read from a file, or the failure of one whose stored text would
// not read back: it can be many times as long as the text it was read from, as a!A1 is far down the grid.
export function storedKey(tree: FormulaNode): string | ParseFailure {
    const key = printStored(tree);
    return key.length > MAX_STORED_LENGTH ? { reason: 'too-long', at: 0 } : key;
}

// The formula as it reads at a cell, row and column from 0. `sheetName` gives a sheet's name by its id.
export function printA1(tree: FormulaNode, hostRow: number, hostColumn: number, sheetName: SheetNames): string {
    return `=${print(tree, false, hostRow, hostColumn, sheetName)}`;
}

// A tree in the spellings of a file, as xlsxTree makes one, at a cell.
export function printXlsx(tree: FormulaNode, hostRow: number, hostColumn: number, sheetName: SheetNames): string {
    return print(tree, false, hostRow, hostColumn, sheetName);
}

function print(node: FormulaNode, stored: boolean, row: number, column: number, sheetName: SheetNames): string {
    const { children, space } = node;
    switch (node.kind) {
        case NodeKind.Number:
            return space + numberText(node.value);
        case NodeKind.String:
            return `${space}"${node.text.includes('"') ? node.text.replaceAll('"', '""') : node.text}"`;
        case NodeKind.Boolean:
            return space + (node.value === 1 ? 'TRUE' : 'FALSE');
        case NodeKind.Empty:
            return '';
        case NodeKind.Error:
        case NodeKind.Name:
        case NodeKind.Table: {
            const prefix = sheetPrefix(node, stored, sheetName);
            if (prefix === null) return `${space}#REF!`;
            if (node.kind === NodeKind.Error) return space + prefix + ERROR_LITERALS[node.value - 1];
            if (node.kind === NodeKind.Table) return space + prefix + node.text;
            // Another workbook's name can be any text, so it is quoted unless it reads back bare as itself.
            const bare = node.sheetKind !== SheetKind.External || (isWord(node.text) && !readsAsReference(node.text));
            return space + prefix + (bare ? node.text : inQuotes(node.text));
        }
        case NodeKind.Ref:
            return space + reference(node, stored, row, column, sheetName);
        case NodeKind.Call:
            return `${space}${node.text}${node.spaceOpen}(${list(node, 0, 0, stored, row, column, sheetName)}${node.spaceEnd})`;
        case NodeKind.Invoke: {
            const callee = print(children[0], stored, row, column, sheetName);
            return `${callee}(${list(node, 1, 0, stored, row, column, sheetName)}${node.spaceEnd})`;
        }
        case NodeKind.Prefix:
            return space + SYMBOLS[node.op] + print(children[0], stored, row, column, sheetName);
        case NodeKind.Postfix:
            return print(children[0], stored, row, column, sheetName) + space + SYMBOLS[node.op];
        case NodeKind.Binary: {
            // A sum of thousands of terms is a chain that deep down its left operands, so it is read in a loop.
            let chain = node;
            let text = '';
            while (chain.kind === NodeKind.Binary) {
                const left = chain.children[0];
                let right = print(chain.children[1], stored, row, column, sheetName);
                if (chain.op === Token.Colon && chain.space === '') {
                    // A name, a colon and a bare sheet read as the two sheets of a 3-D reference, so that sheet is
                    // quoted.
                    const before = left.kind === NodeKind.Binary ? left.children[1] : left;
                    const sheet = right.slice(0, Math.max(0, right.indexOf('!')));
                    const named = before.kind === NodeKind.Name && before.sheetKind === SheetKind.Host;
                    if (named && isWord(sheet)) right = inQuotes(sheet) + right.slice(sheet.length);
                }
                text = chain.space + SYMBOLS[chain.op] + right + text;
                chain = left;
            }
            return print(chain, stored, row, column, sheetName) + text;
        }
        case NodeKind.Paren:
            return `${space}(${print(children[0], stored, row, column, sheetName)}${node.spaceEnd})`;
        case NodeKind.Array:
            return `${space}{${list(node, 0, node.op, stored, row, column, sheetName)}${node.spaceEnd}}`;
    }
}

// The one spelling of a number: the shortest digits that read back as it, plain where Excel rewrites a literal to
// plain digits on entry. JavaScript turns to E notation at 1E+21, as Excel does, but below 1 already at 1E-7.
function numberText(value: number): string {
    const short = String(value);
    if (!short.includes('e')) return short;
    const [mantissa, power] = short.split('e');
    const exponent = Number(power);
    if (exponent > 0 || exponent < PLAIN_EXPONENT_MIN) return `${mantissa}E${power}`;
    return `0.${'0'.repeat(-exponent - 1)}${mantissa.replace('.', '')}`;
}

// The children from `from` on with commas between, and a semicolon where a row of `columns` ends.
function list(
    node: FormulaNode,
    from: number,
    columns: number,
    stored: boolean,
    row: number,
    column: number,
    sheetName: SheetNames,
): string {
    const { children } = node;
    let text = '';
    for (let i = from; i < children.length; i += 1) {
        if (i > from) text += columns > 0 && i % columns === 0 ? ';' : ',';
        text += print(children[i], stored, row, column, sheetName);
    }
    return text;
}

// The sheet prefix with its !, empty for the host's own sheet, or null for a sheet that is gone.
function sheetPrefix(node: FormulaNode, stored: boolean, sheetName: SheetNames): string | null {
    const { sheet } = node;
    switch (node.sheetKind) {
        case SheetKind.Host:
            return '';
        case SheetKind.Id: {
            if (stored) return `[${sheet}]!`;
            const name = sheetName(sheet);
            return name === undefined ? null : `${quoteSheetName(name)}!`;
        }
        case SheetKind.Name:
            return `${stored ? inQuotes(sheet) : quoteSheetName(sheet)}!`;
        case SheetKind.External:
        case SheetKind.Span: {
            // Stored text reads a bare bracket as a sheet id. Typed, the prefix is bare when it reads back as itself
            // and the workbook in its brackets is one word, as Excel writes it.
            const book = node.sheetKind === SheetKind.Span || isWord(`_${sheet.slice(1, sheet.indexOf(']'))}`);
            const bare = stored || !book ? null : referenceAt(`${sheet}!A1`, 0);
            const same = bare?.end === sheet.length + 3 && bare.node.sheetKind === node.sheetKind;
            return `${same && bare.node.sheet === sheet ? sheet : inQuotes(sheet)}!`;
        }
    }
}

function reference(
    node: FormulaNode,
    stored: boolean,
    hostRow: number,
    hostColumn: number,
    sheetName: SheetNames,
): string {
    const prefix = sheetPrefix(node, stored, sheetName);
    if (prefix === null) return '#REF!';
    const { op, flags } = node;
    if (stored) {
        const rows = op !== RefKind.Columns;
        const columns = op !== RefKind.Rows;
        const start =
            (rows ? `R${storedIndex(node.row, flags & RefFlag.RowAbsolute)}` : '') +
            (columns ? `C${storedIndex(node.column, flags & RefFlag.ColumnAbsolute)}` : '');
        if (op === RefKind.Cell) return prefix + start;
        const end =
            (rows ? `R${storedIndex(node.row2, flags & RefFlag.Row2Absolute)}` : '') +
            (columns ? `C${storedIndex(node.column2, flags & RefFlag.Column2Absolute)}` : '');
        return `${prefix}${start}:${end}`;
    }
    const rowEnds: Ends = { first: 0, second: 0 };
    const columnEnds: Ends = { first: 0, second: 0 };
    const onGrid =
        endsAt(node, true, hostRow, GRID_ROWS, rowEnds) && endsAt(node, false, hostColumn, GRID_COLUMNS, columnEnds);
    if (!onGrid) return `${prefix}#REF!`;
    let top = (flags & RefFlag.RowAbsolute ? '$' : '') + (rowEnds.first + 1);
    let left = (flags & RefFlag.ColumnAbsolute ? '$' : '') + columnLabel(columnEnds.first);
    if (op === RefKind.Cell) return prefix + left + top;
    let bottom = (flags & RefFlag.Row2Absolute ? '$' : '') + (rowEnds.second + 1);
    let right = (flags & RefFlag.Column2Absolute ? '$' : '') + columnLabel(columnEnds.second);
    // The corners print in order at this host, each coordinate taking its $ along, as Excel shows a range.
    if (rowEnds.first > rowEnds.second) [top, bottom] = [bottom, top];
    if (columnEnds.first > columnEnds.second) [left, right] = [right, left];
    if (op === RefKind.Columns) return `${prefix}${left}:${right}`;
    if (op === RefKind.Rows) return `${prefix}${top}:${bottom}`;
    return `${prefix}${left}${top}:${right}${bottom}`;
}

function storedIndex(value: number, absolute: number): string {
    if (absolute !== 0) return String(value + 1);
    return value === 0 ? '' : `[${value}]`;
}
