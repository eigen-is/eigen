// The docs editor's table, EditorTable: TipTap's table with Google Docs' column drag, which moves width between two
// columns, and the commands Format › Table and the table panel run, such as Distribute columns and the border rows.
// The server's schema keeps the plain table node; this one adds behavior and no attribute.

import type { CommandProps } from '@tiptap/core';
import { Table } from '@tiptap/extension-table';
import type { Node as PMNode } from '@tiptap/pm/model';
import type { Transaction } from '@tiptap/pm/state';
import { Plugin } from '@tiptap/pm/state';
import {
    cellAround,
    columnResizingPluginKey,
    isInTable,
    selectedRect,
    TableMap,
    TableView,
    updateColumnsOnResize,
} from '@tiptap/pm/tables';
import type { EditorView } from '@tiptap/pm/view';
import { MIN_TABLE_COLUMN_PX } from '@workspace/lib/docs/eigendoc';
import { clamp } from '@workspace/lib/vector';
import type { BorderSet } from './table-look';
import { addColumnWithLook, addRowWithLook, setCellBorderColor, setCellBorders } from './table-look';
import { contentWidth, textColumnWidth } from './text-column';

declare module '@tiptap/core' {
    interface Commands<ReturnType> {
        editorTable: {
            distributeColumns: () => ReturnType;
            setCellBorders: (set: BorderSet) => ReturnType;
            setCellBorderColor: (color: string) => ReturnType;
        };
    }
}

const sum = (widths: number[]) => widths.reduce((total, width) => total + width, 0);

// Google Docs' column drag, by dx on column `col`'s right border: a border between two columns moves width from one to
// the other, each kept at the floor, so the table keeps its width; the last column's border sets the table's width, up
// to maxTableWidth. A column already past a limit is never pushed further past it.
function draggedWidths(start: number[], col: number, dx: number, maxTableWidth: number): number[] {
    const widths = [...start];
    const own = start[col] ?? 0;
    const next = start[col + 1];
    if (next === undefined) {
        const room = maxTableWidth - (sum(start) - own);
        widths[col] = Math.round(clamp(own + dx, Math.min(own, MIN_TABLE_COLUMN_PX), Math.max(own, room)));
    } else {
        const moved = Math.round(
            clamp(dx, Math.min(0, MIN_TABLE_COLUMN_PX - own), Math.max(0, next - MIN_TABLE_COLUMN_PX)),
        );
        widths[col] = own + moved;
        widths[col + 1] = next - moved;
    }
    return widths;
}

// The widest the table at `tablePos` draws: the content box of the block it sits in, a list item or a cell, within
// the text column. Null when neither is laid out.
function maxTableWidth(view: EditorView, tablePos: number): number | null {
    const container = view.nodeDOM(tablePos)?.parentElement;
    const fits = container ? contentWidth(container) : null;
    const column = textColumnWidth(view.dom);
    return fits !== null && column !== null ? Math.min(fits, column) : (fits ?? column);
}

// Every column's stored width, read off its first-row cell, 0 for none.
function storedWidths(table: PMNode, map: TableMap): number[] {
    return map.map
        .slice(0, map.width)
        .map((pos, col): number => table.nodeAt(pos)?.attrs['colwidth']?.[col - map.colCount(pos)] || 0);
}

// Every column's width: its stored one, or the share it draws at of its first-row cell's width.
function columnWidths(view: EditorView, table: PMNode, tableStart: number, map: TableMap): number[] {
    const stored = storedWidths(table, map);
    return stored.map((width, col) => {
        if (width) return width;
        const pos = map.map[col] ?? 0;
        const first = map.colCount(pos);
        const spanned = stored.slice(first, first + (table.nodeAt(pos)?.attrs['colspan'] ?? 1));
        const dom = view.nodeDOM(tableStart + pos);
        const drawn = dom instanceof HTMLElement ? dom.offsetWidth : 0;
        const unknown = spanned.filter((spannedWidth) => !spannedWidth).length;
        return Math.max(MIN_TABLE_COLUMN_PX, Math.round((drawn - sum(spanned)) / unknown));
    });
}

function drawColumns(tableDom: HTMLTableElement, widths: number[]) {
    const cols = tableDom.querySelector(':scope > colgroup')?.children ?? [];
    for (const [index, col] of [...cols].entries()) {
        if (col instanceof HTMLElement) col.style.width = `${widths[index] ?? MIN_TABLE_COLUMN_PX}px`;
    }
    tableDom.style.width = `${sum(widths)}px`;
    tableDom.style.minWidth = '';
}

// Every cell of the table takes its columns' widths; a cell that has them already is left as it is. A row's map
// meets its own cells in their order, each first at its leftmost column, so the walk reads each cell once.
function setColumnWidths(tr: Transaction, table: PMNode, tableStart: number, widths: number[]) {
    const map = TableMap.get(table);
    const seen = new Set<number>();
    table.forEach((row, _offset, rowIndex) => {
        let next = 0;
        for (let col = 0; col < map.width; col++) {
            const pos = map.map[rowIndex * map.width + col];
            if (pos === undefined || seen.has(pos)) continue;
            seen.add(pos);
            const cell = row.maybeChild(next++);
            if (!cell) continue;
            const colwidth = widths.slice(col, col + cell.attrs['colspan']);
            const old: number[] | null = cell.attrs['colwidth'];
            if (old && colwidth.every((width, k) => width === old[k])) continue;
            tr.setNodeMarkup(tableStart + pos, null, { ...cell.attrs, colwidth });
        }
    });
}

// The table node `tableDom` draws and its position, found from the DOM rather than a position mapped through the drag's
// changes: y-tiptap applies a collaborator's change as one replace of the whole document, which no position survives,
// while the table's node view does. Null when the table went.
function tableOf(view: EditorView, tableDom: HTMLTableElement): { table: PMNode; pos: number } | null {
    if (!view.dom.contains(tableDom)) return null;
    // The position at the table's start, inside it.
    const $start = view.state.doc.resolve(view.posAtDOM(tableDom, 0));
    const pos = $start.before();
    return view.nodeDOM(pos)?.firstChild === tableDom ? { table: $start.parent, pos } : null;
}

// Where in a cell a right-click landed, at the pointer: the start of the element it hit would fall outside a selection
// within that paragraph. Null outside a table.
export function cellPosAt(view: EditorView, event: MouseEvent): number | null {
    if (!(event.target instanceof Node) || !view.dom.contains(event.target)) return null;
    const pos = view.posAtCoords({ left: event.clientX, top: event.clientY })?.pos;
    if (pos !== undefined && cellAround(view.state.doc.resolve(pos))) return pos;
    // Cell padding or a border resolves between the cells: the cell under the pointer still has its menu.
    const cell = event.target instanceof Element ? event.target.closest('td, th') : null;
    return cell && view.dom.contains(cell) ? view.posAtDOM(cell, 0) : null;
}

// Takes over columnResizing's drag from mousedown to mouseup and keeps the rest of it: the hover that finds the border,
// and its handle and cursor, which this plugin holds still during a drag by taking the editor's mousemove and
// mouseleave ahead of it. Its own drag sets one column, so a table that fills the text column could only grow; this
// one moves width between the border's two columns instead. The first drag stores every column's width, so none is
// left to the layout; a drag that changes nothing, a click, writes nothing.
function columnDrag(cellMinWidth: number) {
    let dragging = false;
    return new Plugin({
        props: {
            handleDOMEvents: {
                mousemove: () => dragging,
                mouseleave: () => dragging,
                mousedown(view, event) {
                    const handle = columnResizingPluginKey.getState(view.state)?.activeHandle ?? -1;
                    if (!view.editable || handle < 0) return false;
                    // Only the primary button drags, without control or command, as tableEditing reads them: macOS's
                    // control-click is its right-click. Another press is taken here, or columnResizing's own mousedown
                    // would start its drag and write the column's width on the mouseup.
                    if (event.button !== 0 || event.ctrlKey || event.metaKey) return true;
                    const $cell = view.state.doc.resolve(handle);
                    const table = $cell.node(-1);
                    const tablePos = $cell.before(-1);
                    const map = TableMap.get(table);
                    const col = map.colCount($cell.pos - tablePos - 1) + ($cell.nodeAfter?.attrs['colspan'] ?? 1) - 1;
                    const dom = view.nodeDOM(tablePos)?.firstChild;
                    if (!(dom instanceof HTMLTableElement)) return false;

                    const start = columnWidths(view, table, tablePos + 1, map);
                    const maxWidth = maxTableWidth(view, tablePos) ?? Infinity;
                    // The page may be drawn scaled; widths are in the page's own pixels.
                    const scale = dom.offsetWidth > 0 ? dom.getBoundingClientRect().width / dom.offsetWidth : 1;
                    const widthsAt = (clientX: number) =>
                        draggedWidths(start, col, (clientX - event.clientX) / scale, maxWidth);

                    const win = view.dom.ownerDocument.defaultView ?? window;
                    // A move with no button down means the mouseup was lost, outside the window or to a native menu,
                    // so the drag ends where the last move with the button down left it.
                    let lastX = event.clientX;
                    const move = (moveEvent: MouseEvent) => {
                        if (!moveEvent.buttons) return finish(lastX);
                        lastX = moveEvent.clientX;
                        drawColumns(dom, widthsAt(lastX));
                    };
                    const up = (upEvent: MouseEvent) => finish(upEvent.clientX);
                    // The drop finds the table again, where a collaborator's edit may have changed it; a table whose
                    // columns changed meanwhile keeps its widths, and a table that went takes nothing. Without a write
                    // the table draws from its node again, as the moves drew over it.
                    const finish = (clientX: number) => {
                        win.removeEventListener('mouseup', up);
                        win.removeEventListener('mousemove', move);
                        dragging = false;
                        const found = tableOf(view, dom);
                        if (!found) return;
                        const widths = widthsAt(clientX);
                        const changed = widths.some((width, index) => width !== start[index]);
                        if (changed && TableMap.get(found.table).width === widths.length) {
                            const tr = view.state.tr;
                            setColumnWidths(tr, found.table, found.pos + 1, widths);
                            if (tr.docChanged) return view.dispatch(tr);
                        }
                        const colgroup = dom.firstChild;
                        if (colgroup instanceof HTMLTableColElement) {
                            updateColumnsOnResize(found.table, colgroup, dom, cellMinWidth);
                        }
                    };

                    dragging = true;
                    win.addEventListener('mouseup', up);
                    win.addEventListener('mousemove', move);
                    event.preventDefault();
                    return true;
                },
            },
        },
    });
}

// The docs editor's table. prosemirror-tables' own TableView, not TipTap's, because TipTap's leaves a column's dragged
// width drawn when an undo takes its colwidth back to none. `resizable` is off for a coarse pointer (editor.tsx). A row
// or column it adds takes its neighbor's look.
export const EditorTable = Table.extend({
    addCommands() {
        return {
            ...this.parent?.(),
            addRowBefore:
                () =>
                ({ state, dispatch }: CommandProps) =>
                    addRowWithLook('before')(state, dispatch),
            addRowAfter:
                () =>
                ({ state, dispatch }: CommandProps) =>
                    addRowWithLook('after')(state, dispatch),
            addColumnBefore:
                () =>
                ({ state, dispatch }: CommandProps) =>
                    addColumnWithLook('before')(state, dispatch),
            addColumnAfter:
                () =>
                ({ state, dispatch }: CommandProps) =>
                    addColumnWithLook('after')(state, dispatch),
            setCellBorders:
                (set: BorderSet) =>
                ({ state, dispatch }: CommandProps) =>
                    setCellBorders(set)(state, dispatch),
            setCellBorderColor:
                (color: string) =>
                ({ state, dispatch }: CommandProps) =>
                    setCellBorderColor(color)(state, dispatch),
            // Google Docs' Distribute columns: one width for every column, splitting the table's own width, or the
            // widest the table draws when a column has none and the table draws at that width.
            distributeColumns:
                () =>
                ({ state, tr, dispatch, view }: CommandProps) => {
                    if (!isInTable(state)) return false;
                    const { map, table, tableStart } = selectedRect(state);
                    const stored = storedWidths(table, map);
                    const maxWidth = maxTableWidth(view, tableStart - 1);
                    const tableWidth = stored.every((width) => width > 0) ? sum(stored) : (maxWidth ?? 0);
                    const total = Math.min(tableWidth, maxWidth ?? Infinity);
                    if (total <= 0) return false;
                    const width = Math.max(MIN_TABLE_COLUMN_PX, Math.floor(total / map.width));
                    if (dispatch)
                        setColumnWidths(
                            tr,
                            table,
                            tableStart,
                            Array.from({ length: map.width }, () => width),
                        );
                    return true;
                },
        };
    },
    addProseMirrorPlugins() {
        const plugins = this.parent?.() ?? [];
        return this.options.resizable && this.editor.isEditable
            ? [columnDrag(this.options.cellMinWidth), ...plugins]
            : plugins;
    },
}).configure({ resizable: true, cellMinWidth: MIN_TABLE_COLUMN_PX, View: TableView });
