// What a formula's stored text becomes when a block of cells moves, as a cut and paste or a drag does it. A
// reference to cells that are all in the block follows them, from any sheet; one to cells the block landed on is
// #REF!; and a formula that moved keeps reading what it read, so its offsets to cells outside the block change.
// The store calls this for the formulas in the block and for those the reverse index finds reading it.

import { GRID_COLUMNS, GRID_ROWS } from '../text/a1';
import type { FormulaNode } from '../text/tree';
import { leaf, NodeKind, RefFlag, RefKind, referenceNode, SheetKind } from '../text/tree';
import { mapLeaves, sheetOf } from './leaves';
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
): Transformed {
    const rowShift = move.toRow - move.row;
    const columnShift = move.toColumn - move.column;
    const carried =
        hostSheet === move.fromSheet && covers(move, move.row, move.column, hostRow, hostColumn, hostRow, hostColumn);
    const sheetAfter = carried ? move.toSheet : hostSheet;
    const rowAfter = carried ? hostRow + rowShift : hostRow;
    const columnAfter = carried ? hostColumn + columnShift : hostColumn;
    let lossy = false;
    let recompute = false;
    const mapped = mapLeaves(tree, (node) => {
        if (node.kind !== NodeKind.Ref) return node;
        const { op, flags, sheetKind } = node;
        const rowless = op === RefKind.Columns;
        const columnless = op === RefKind.Rows;
        let row = flags & RefFlag.RowAbsolute ? node.row : hostRow + node.row;
        let column = flags & RefFlag.ColumnAbsolute ? node.column : hostColumn + node.column;
        let row2 = op === RefKind.Cell ? row : flags & RefFlag.Row2Absolute ? node.row2 : hostRow + node.row2;
        let column2 =
            op === RefKind.Cell ? column : flags & RefFlag.Column2Absolute ? node.column2 : hostColumn + node.column2;
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
                return leaf(NodeKind.Error, 0, '#REF!', node.space, sheetKind, node.sheet);
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
    return { tree: mapped, lossy, recompute, resized: false };
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
