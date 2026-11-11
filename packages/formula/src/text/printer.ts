// The two printers over the one tree. printStored writes the canonical shape text, which is what a cell stores and
// what the shape table keys on: offsets in R1C1 notation and sheets by id. printA1 writes what a person reads at a
// given cell, in the formula bar, on the clipboard and from FORMULATEXT: labels, sheet names, corners in order, and
// #REF! for a reference that falls off the grid there or names a sheet that is gone.

import { columnLabel, GRID_COLUMNS, GRID_ROWS } from './a1';
import { ERROR_LITERALS, SYMBOLS } from './lexer';
import { quotedSheetName, quoteSheetName } from './sheet-name';
import type { Ends, FormulaNode } from './tree';
import { endsAt, NodeKind, RefFlag, RefKind, SheetKind } from './tree';

export type SheetNames = (id: string) => string | undefined;

export function printStored(tree: FormulaNode): string {
    return `=${print(tree, true, 0, 0, noName)}`;
}

// The formula as it reads at a cell, row and column from 0. `sheetName` gives a sheet's name by its id.
export function printA1(tree: FormulaNode, hostRow: number, hostColumn: number, sheetName: SheetNames): string {
    return `=${print(tree, false, hostRow, hostColumn, sheetName)}`;
}

function noName(): undefined {
    return undefined;
}

function print(node: FormulaNode, stored: boolean, row: number, column: number, sheetName: SheetNames): string {
    const { children, space } = node;
    switch (node.kind) {
        case NodeKind.Number: {
            const text = String(node.value);
            return space + (text.includes('e') ? text.replace('e', 'E') : text);
        }
        case NodeKind.String:
            return `${space}"${node.text.includes('"') ? node.text.replaceAll('"', '""') : node.text}"`;
        case NodeKind.Boolean:
            return space + (node.value === 1 ? 'TRUE' : 'FALSE');
        case NodeKind.Empty:
            return '';
        case NodeKind.Error:
        case NodeKind.Name: {
            const prefix = sheetPrefix(node, stored, sheetName);
            if (prefix === null) return `${space}#REF!`;
            return space + prefix + (node.kind === NodeKind.Name ? node.text : ERROR_LITERALS[node.value - 1]);
        }
        case NodeKind.Ref:
            return space + reference(node, stored, row, column, sheetName);
        case NodeKind.Call:
            return `${space}${node.text}(${list(node, 0, 0, stored, row, column, sheetName)}${node.spaceEnd})`;
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
                const right = print(chain.children[1], stored, row, column, sheetName);
                text = chain.space + SYMBOLS[chain.op] + right + text;
                chain = chain.children[0];
            }
            return print(chain, stored, row, column, sheetName) + text;
        }
        case NodeKind.Paren:
            return `${space}(${print(children[0], stored, row, column, sheetName)}${node.spaceEnd})`;
        case NodeKind.Array:
            return `${space}{${list(node, 0, node.op, stored, row, column, sheetName)}${node.spaceEnd}}`;
    }
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
            return `${stored ? quotedSheetName(sheet) : quoteSheetName(sheet)}!`;
        case SheetKind.External:
        case SheetKind.Span:
            return `${quotedSheetName(sheet)}!`;
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
