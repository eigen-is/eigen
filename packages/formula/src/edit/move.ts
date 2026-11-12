// What a formula's stored text becomes when a block of cells moves, as a cut and paste or a drag does it. A
// reference to cells that are all in the block follows them, from any sheet; one to cells the block landed on is
// #REF!; a formula that moved keeps reading what it read; any other reference keeps its text, and is a seed when it
// reads a cell the block left or landed on. Whether a reference lies in a block is a test per row and per column,
// so moveClasses cuts a block of hosts into a grid of blocks with one outcome each, not one per formula.

import { GRID_COLUMNS, GRID_ROWS } from '../text/a1';
import type { Ends, FormulaNode } from '../text/tree';
import { endsAt, NodeKind, RefFlag, RefKind, referenceNode, SheetKind } from '../text/tree';
import { broken, mapLeaves, sheetOf } from './leaves';
import type { Transformed } from './transform';

// The block of `rows` by `columns` cells at `row`, `column` goes to `toRow`, `toColumn`. Sheets are ids.
export type Move = {
    readonly fromSheet: string;
    readonly row: number;
    readonly column: number;
    readonly rows: number;
    readonly columns: number;
    readonly toSheet: string;
    readonly toRow: number;
    readonly toColumn: number;
};

export type Moved = Omit<Transformed, 'resized' | 'slid'>;

// The hosts of one formula on the rows `top` to `bottom` and the columns `left` to `right`, before the move, which
// all get this outcome. `carried` says they are in the block and move with it.
export type MoveClass = Moved & {
    readonly top: number;
    readonly bottom: number;
    readonly left: number;
    readonly right: number;
    readonly carried: boolean;
};

// The outcomes for the hosts of one formula in a block of one sheet. Hosts the move lands on are left out, as they
// are gone. `references` are the tree's reference leaves.
export function moveClasses(
    tree: FormulaNode,
    references: readonly FormulaNode[],
    move: Move,
    hostSheet: string,
    top: number,
    bottom: number,
    left: number,
    right: number,
): MoveClass[] {
    const rowCuts = cuts(references, move, hostSheet, true, top, bottom);
    const columnCuts = cuts(references, move, hostSheet, false, left, right);
    const classes: MoveClass[] = [];
    for (let i = 0; i < rowCuts.length; i += 1) {
        const row = rowCuts[i];
        const lastRow = i + 1 < rowCuts.length ? rowCuts[i + 1] - 1 : bottom;
        for (let j = 0; j < columnCuts.length; j += 1) {
            const column = columnCuts[j];
            const lastColumn = j + 1 < columnCuts.length ? columnCuts[j + 1] - 1 : right;
            const carried =
                hostSheet === move.fromSheet && covers(move, move.row, move.column, row, column, row, column);
            const landedOn =
                hostSheet === move.toSheet && covers(move, move.toRow, move.toColumn, row, column, row, column);
            if (landedOn && !carried) continue;
            const moved = transformMove(tree, move, hostSheet, row, column);
            classes.push({ ...moved, top: row, bottom: lastRow, left: column, right: lastColumn, carried });
        }
    }
    return classes;
}

// The host lines from `from` to `to` on one axis where a class starts: where the host, or an end of a reference
// that travels with it, crosses an edge of the block or of where the block lands.
function cuts(
    references: readonly FormulaNode[],
    move: Move,
    hostSheet: string,
    rows: boolean,
    from: number,
    to: number,
): number[] {
    const first = rows ? move.row : move.column;
    const target = rows ? move.toRow : move.toColumn;
    const size = rows ? move.rows : move.columns;
    const edges = [first, first + size, target, target + size];
    const absolute = rows ? RefFlag.RowAbsolute : RefFlag.ColumnAbsolute;
    const absolute2 = rows ? RefFlag.Row2Absolute : RefFlag.Column2Absolute;
    const found: number[] = [];
    if (hostSheet === move.fromSheet) found.push(first, first + size);
    if (hostSheet === move.toSheet) found.push(target, target + size);
    for (const reference of references) {
        const { op, flags } = reference;
        if (op === (rows ? RefKind.Columns : RefKind.Rows)) continue;
        for (const edge of edges) {
            if ((flags & absolute) === 0) found.push(edge - (rows ? reference.row : reference.column));
            if (op !== RefKind.Cell && (flags & absolute2) === 0) {
                found.push(edge - (rows ? reference.row2 : reference.column2));
            }
        }
    }
    found.sort((a, b) => a - b);
    const starts = [from];
    for (const line of found) {
        if (line > starts[starts.length - 1] && line <= to) starts.push(line);
    }
    return starts;
}

// The host is the formula's cell before the move. A formula the block landed on is gone and is not asked.
export function transformMove(
    tree: FormulaNode,
    move: Move,
    hostSheet: string,
    hostRow: number,
    hostColumn: number,
): Moved {
    const rowShift = move.toRow - move.row;
    const columnShift = move.toColumn - move.column;
    const carried =
        hostSheet === move.fromSheet && covers(move, move.row, move.column, hostRow, hostColumn, hostRow, hostColumn);
    const sheetAfter = carried ? move.toSheet : hostSheet;
    const rowAfter = carried ? hostRow + rowShift : hostRow;
    const columnAfter = carried ? hostColumn + columnShift : hostColumn;
    const ends: Ends = { first: 0, second: 0 };
    let lossy = false;
    let recompute = false;
    const mapped = mapLeaves(tree, (node) => {
        if (node.kind !== NodeKind.Ref) return node;
        const { op, flags, sheetKind } = node;
        const rowless = op === RefKind.Columns;
        const columnless = op === RefKind.Rows;
        endsAt(node, true, hostRow, GRID_ROWS, ends);
        let row = ends.first;
        let row2 = ends.second;
        endsAt(node, false, hostColumn, GRID_COLUMNS, ends);
        let column = ends.first;
        let column2 = ends.second;
        const read = sheetOf(node, hostSheet);
        let sheet = read ?? node.sheet;
        if (read !== null) {
            const top = rowless ? 0 : Math.min(row, row2);
            const bottom = rowless ? GRID_ROWS - 1 : Math.max(row, row2);
            const left = columnless ? 0 : Math.min(column, column2);
            const right = columnless ? GRID_COLUMNS - 1 : Math.max(column, column2);
            if (sheet === move.fromSheet && covers(move, move.row, move.column, top, left, bottom, right)) {
                row += rowShift;
                row2 += rowShift;
                column += columnShift;
                column2 += columnShift;
                sheet = move.toSheet;
            } else if (sheet === move.toSheet && covers(move, move.toRow, move.toColumn, top, left, bottom, right)) {
                lossy = true;
                recompute = true;
                return broken(node);
            } else if (
                (sheet === move.fromSheet && meets(move, move.row, move.column, top, left, bottom, right)) ||
                (sheet === move.toSheet && meets(move, move.toRow, move.toColumn, top, left, bottom, right))
            ) {
                // It reads a cell the block left empty or one the block landed on.
                recompute = true;
            }
        }
        // A sheet that was written stays written. An unwritten one is named once it is no longer the host's, and
        // the move back cannot tell that name from a written one, so undo needs the old text.
        const kept = read === null || (sheetKind === SheetKind.Host && sheet === sheetAfter);
        const nextKind = kept ? sheetKind : SheetKind.Id;
        const nextSheet = kept ? node.sheet : sheet;
        if (nextKind !== sheetKind) lossy = true;
        const nextRow = rowless ? 0 : flags & RefFlag.RowAbsolute ? row : row - rowAfter;
        const nextColumn = columnless ? 0 : flags & RefFlag.ColumnAbsolute ? column : column - columnAfter;
        const nextRow2 = rowless || op === RefKind.Cell ? 0 : flags & RefFlag.Row2Absolute ? row2 : row2 - rowAfter;
        const nextColumn2 =
            columnless || op === RefKind.Cell ? 0 : flags & RefFlag.Column2Absolute ? column2 : column2 - columnAfter;
        if (
            nextRow === node.row &&
            nextColumn === node.column &&
            nextRow2 === node.row2 &&
            nextColumn2 === node.column2 &&
            nextKind === sheetKind &&
            nextSheet === node.sheet
        ) {
            return node;
        }
        return referenceNode(op, node.space, nextKind, nextSheet, nextRow, nextColumn, nextRow2, nextColumn2, flags);
    });
    return { tree: mapped, lossy, recompute };
}

// Whether the block of the move's size at `row`, `column` holds the whole rectangle.
function covers(
    move: Move,
    row: number,
    column: number,
    top: number,
    left: number,
    bottom: number,
    right: number,
): boolean {
    return top >= row && bottom < row + move.rows && left >= column && right < column + move.columns;
}

// Whether the block of the move's size at `row`, `column` holds a cell of the rectangle.
function meets(
    move: Move,
    row: number,
    column: number,
    top: number,
    left: number,
    bottom: number,
    right: number,
): boolean {
    return bottom >= row && top < row + move.rows && right >= column && left < column + move.columns;
}
