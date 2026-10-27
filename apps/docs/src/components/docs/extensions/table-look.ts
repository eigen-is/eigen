// The look a docs table's cells keep of their own, their fill and border sides, as the editor sets it. The Borders row
// and Border color of the table panel and Format › Table set the selected cells' sides, and the facing side of each
// cell beside the selection, since the editor draws a shared edge from both cells. A row or column the table grows by
// takes its neighbour's look. EditorTable registers these as its commands.

import type { Command, EditorState, Transaction } from '@tiptap/pm/state';
import type { Rect } from '@tiptap/pm/tables';
import { addColumn, addRow, isInTable, selectedRect, TableMap } from '@tiptap/pm/tables';
import type { CellBorder, CellBorderAttribute, CellSide } from '@workspace/lib/docs/eigendoc';
import { CELL_BORDER_SIDES, cellBorderValue, readCellBorder } from '@workspace/lib/docs/eigendoc';

export type BorderSet = 'all' | 'outer' | 'none';

const FACING = {
    borderTop: 'borderBottom',
    borderRight: 'borderLeft',
    borderBottom: 'borderTop',
    borderLeft: 'borderRight',
} as const;

const LOOK = ['backgroundColor', ...CELL_BORDER_SIDES.map(([name]) => name)];

// The pen a selection draws borders with: the first side its first cell draws of its own, null for Eigen's own look.
export function cellBorderPen(state: EditorState): Exclude<CellBorder, 'none'> | null {
    if (!isInTable(state)) return null;
    const { map, table, top, left } = selectedRect(state);
    const cell = table.nodeAt(map.map[top * map.width + left] ?? -1);
    for (const [name] of CELL_BORDER_SIDES) {
        const border = readCellBorder(cell?.attrs[name]);
        if (border && border !== 'none') return border;
    }
    return null;
}

// All draws every side in the pen, Outer the selection's edge and none inside it, None no side at all.
export function setCellBorders(set: BorderSet): Command {
    return (state, dispatch) => {
        const pen = cellBorderPen(state);
        const value = pen && cellBorderValue(pen);
        return writeSides(state, dispatch, (_, edge) =>
            set === 'none' || (set === 'outer' && !edge) ? 'none' : value,
        );
    };
}

// Every side the selection draws takes the color; a selection that draws none gets every side in it.
export function setCellBorderColor(color: string): Command {
    return (state, dispatch) => {
        const pen = cellBorderPen(state);
        const border = readCellBorder(
            cellBorderValue({ width: pen?.width ?? 1, style: pen?.style ?? 'solid', color: color.toLowerCase() }),
        );
        if (!border || !isInTable(state)) return false;
        const value = cellBorderValue(border);
        const rect = selectedRect(state);
        const drawn = rect.map
            .cellsInRect(rect)
            .some((pos) =>
                CELL_BORDER_SIDES.some(([name]) => readCellBorder(rect.table.nodeAt(pos)?.attrs[name]) !== 'none'),
            );
        return writeSides(state, dispatch, (current) =>
            drawn && readCellBorder(current) === 'none' ? undefined : value,
        );
    };
}

// Each selected cell's side becomes what `sideOf` answers, undefined leaving it be; a side on the selection's edge sets
// the facing side of the cells across it too.
function writeSides(
    state: EditorState,
    dispatch: ((tr: Transaction) => void) | undefined,
    sideOf: (current: unknown, edge: boolean) => string | null | undefined,
): boolean {
    if (!isInTable(state)) return false;
    if (!dispatch) return true;
    const rect = selectedRect(state);
    const { map, table, tableStart } = rect;
    const changes = new Map<number, Partial<Record<CellBorderAttribute, string | null>>>();
    const change = (pos: number, name: CellBorderAttribute, value: string | null) =>
        changes.set(pos, { ...changes.get(pos), [name]: value });
    for (const pos of map.cellsInRect(rect)) {
        const cell = map.findCell(pos);
        for (const [name, side] of CELL_BORDER_SIDES) {
            const edge = cell[side] === rect[side];
            const value = sideOf(table.nodeAt(pos)?.attrs[name], edge);
            if (value === undefined) continue;
            change(pos, name, value);
            if (edge) for (const across of cellsAcross(map, cell, side)) change(across, FACING[name], value);
        }
    }
    const tr = state.tr;
    for (const [pos, attrs] of changes) {
        const node = table.nodeAt(pos);
        if (node) tr.setNodeMarkup(tableStart + pos, null, { ...node.attrs, ...attrs });
    }
    dispatch(tr);
    return true;
}

// The cells across a side of a cell, none past the table's edge.
function cellsAcross(map: TableMap, cell: Rect, side: CellSide): Set<number> {
    const slots: [number, number][] = [];
    if (side === 'top' || side === 'bottom') {
        const row = side === 'top' ? cell.top - 1 : cell.bottom;
        for (let column = cell.left; column < cell.right; column++) slots.push([row, column]);
    } else {
        const column = side === 'left' ? cell.left - 1 : cell.right;
        for (let row = cell.top; row < cell.bottom; row++) slots.push([row, column]);
    }
    const cells = new Set<number>();
    for (const [row, column] of slots) {
        const pos = row >= 0 && row < map.height && column >= 0 && column < map.width;
        const at = pos ? map.map[row * map.width + column] : undefined;
        if (at !== undefined) cells.add(at);
    }
    return cells;
}

// prosemirror-tables' Add row and Add column, whose new cells take the look of the cells beside them.
export function addRowWithLook(at: 'before' | 'after'): Command {
    return (state, dispatch) => {
        if (!isInTable(state)) return false;
        if (dispatch) {
            const rect = selectedRect(state);
            const row = at === 'before' ? rect.top : rect.bottom;
            const tr = addRow(state.tr, rect, row);
            dispatch(withNeighbourLook(tr, rect.tableStart, 'row', row, at === 'before' ? row + 1 : row - 1));
        }
        return true;
    };
}

export function addColumnWithLook(at: 'before' | 'after'): Command {
    return (state, dispatch) => {
        if (!isInTable(state)) return false;
        if (dispatch) {
            const rect = selectedRect(state);
            const column = at === 'before' ? rect.left : rect.right;
            const tr = addColumn(state.tr, rect, column);
            dispatch(
                withNeighbourLook(tr, rect.tableStart, 'column', column, at === 'before' ? column + 1 : column - 1),
            );
        }
        return true;
    };
}

// A cell over the new row or column alone is new; a merge it widened keeps its own look.
function withNeighbourLook(
    tr: Transaction,
    tableStart: number,
    axis: 'row' | 'column',
    line: number,
    from: number,
): Transaction {
    const table = tr.doc.nodeAt(tableStart - 1);
    if (!table) return tr;
    const map = TableMap.get(table);
    const slot = (index: number, across: number) =>
        map.map[axis === 'row' ? across * map.width + index : index * map.width + across];
    for (let index = 0; index < (axis === 'row' ? map.width : map.height); index++) {
        const pos = slot(index, line);
        const source = slot(index, from);
        if (pos === undefined || source === undefined) continue;
        const cell = map.findCell(pos);
        const fresh =
            axis === 'row'
                ? cell.top === line && cell.bottom === line + 1
                : cell.left === line && cell.right === line + 1;
        const node = table.nodeAt(pos);
        const look = table.nodeAt(source);
        if (fresh && node && look)
            tr.setNodeMarkup(tableStart + pos, null, {
                ...node.attrs,
                ...Object.fromEntries(LOOK.map((name) => [name, look.attrs[name]])),
            });
    }
    return tr;
}
