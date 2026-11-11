// What a formula's stored text becomes when a block of cells moves, as a cut and paste or a drag does it. A
// reference to cells that are all in the block follows them, from any sheet; one to cells the block landed on is
// #REF!; and a formula that moved keeps reading what it read, so its offsets to cells outside the block change.

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

// The host is the formula's cell before the move. A formula the block landed on is gone and is not asked.
export function transformMove(
    tree: FormulaNode,
    move: Move,
    hostSheet: string,
    hostRow: number,
    hostColumn: number,
): Omit<Transformed, 'resized'> {
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
