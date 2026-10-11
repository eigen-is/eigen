import type { CommandProps } from '@tiptap/core';
import { Table } from '@tiptap/extension-table';
import type { Node as PMNode } from '@tiptap/pm/model';
import { Plugin, PluginKey, type Transaction } from '@tiptap/pm/state';
import {
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
import { contentWidth, textColumnWidth } from './text-column';

declare module '@tiptap/core' {
    interface Commands<ReturnType> {
        editorTable: {
            distributeColumns: () => ReturnType;
        };
    }
}

const sum = (widths: number[]) => widths.reduce((total, width) => total + width, 0);

// Google Docs' column drag, by dx on column `col`'s right border: a border between two columns moves width from one to
// the other, each kept at the floor, so the table keeps its width; the last column's border sets the table's width, up
// to maxTableWidth. A column already past a limit is never pushed further past it.
export function draggedWidths(start: number[], col: number, dx: number, maxTableWidth: number): number[] {
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

// Every column's width: its stored one, or the share it draws at of its first-row cell's width.
function columnWidths(view: EditorView, table: PMNode, tableStart: number, map: TableMap): number[] {
    const widths: number[] = [];
    for (let col = 0; col < map.width; ) {
        const pos = map.map[col] ?? 0;
        const cell = table.nodeAt(pos);
        const colspan: number = cell?.attrs['colspan'] ?? 1;
        const stored = Array.from({ length: colspan }, (_, k): number => cell?.attrs['colwidth']?.[k] || 0);
        const unknown = stored.filter((width) => !width).length;
        const dom = unknown > 0 ? view.nodeDOM(tableStart + pos) : null;
        const drawn = dom instanceof HTMLElement ? dom.offsetWidth : 0;
        const share = unknown > 0 ? Math.max(MIN_TABLE_COLUMN_PX, Math.round((drawn - sum(stored)) / unknown)) : 0;
        widths.push(...stored.map((width) => width || share));
        col += colspan;
    }
    return widths;
}

function drawColumns(tableDom: HTMLTableElement, widths: number[]) {
    const cols = tableDom.querySelector(':scope > colgroup')?.children ?? [];
    for (const [index, col] of [...cols].entries()) {
        if (col instanceof HTMLElement) col.style.width = `${widths[index] ?? MIN_TABLE_COLUMN_PX}px`;
    }
    tableDom.style.width = `${sum(widths)}px`;
    tableDom.style.minWidth = '';
}

// Every cell of the table takes its columns' widths; a cell that has them already is left as it is.
function setColumnWidths(tr: Transaction, table: PMNode, tableStart: number, widths: number[]) {
    const map = TableMap.get(table);
    for (const pos of new Set(map.map)) {
        const cell = table.nodeAt(pos);
        if (!cell) continue;
        const first = map.colCount(pos);
        const colwidth = widths.slice(first, first + cell.attrs['colspan']);
        const old: number[] | null = cell.attrs['colwidth'];
        if (old && colwidth.every((width, k) => width === old[k])) continue;
        tr.setNodeMarkup(tableStart + pos, null, { ...cell.attrs, colwidth });
    }
}

// The position of the table a drag is on, mapped through every change while it lasts, or null when there's no drag or
// the table went.
const columnDragKey = new PluginKey<number | null>('columnDrag');

// Takes over columnResizing's drag from mousedown to mouseup and keeps the rest of it: the hover that finds the border,
// and its handle and cursor, which this plugin holds still during a drag by taking the editor's mousemove and
// mouseleave ahead of it. Its own drag sets one column, so a table that fills the text column could only grow; this
// one moves width between the border's two columns instead. The first drag stores every column's width, so none is
// left to the layout; a drag that changes nothing, a click, writes nothing.
function columnDrag(cellMinWidth: number) {
    return new Plugin<number | null>({
        key: columnDragKey,
        state: {
            init: () => null,
            apply(tr, tablePos) {
                const meta: number | null | undefined = tr.getMeta(columnDragKey);
                if (meta !== undefined) return meta;
                if (tablePos === null || !tr.docChanged) return tablePos;
                const mapped = tr.mapping.mapResult(tablePos, 1);
                return mapped.deleted ? null : mapped.pos;
            },
        },
        props: {
            handleDOMEvents: {
                mousemove: (view) => columnDragKey.getState(view.state) != null,
                mouseleave: (view) => columnDragKey.getState(view.state) != null,
                mousedown(view, event) {
                    const handle = columnResizingPluginKey.getState(view.state)?.activeHandle ?? -1;
                    if (!view.editable || handle < 0) return false;
                    // Only the primary button drags. Another one is taken here, or columnResizing's own mousedown
                    // would start its drag and write the column's width on the mouseup.
                    if (event.button !== 0) return true;
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
                    const move = (moveEvent: MouseEvent) => {
                        if (!moveEvent.buttons) return finish(moveEvent);
                        drawColumns(dom, widthsAt(moveEvent.clientX));
                    };
                    // The drop reads the table again from the state, where a collaborator's edit may have changed it;
                    // a table whose columns changed meanwhile keeps its widths. Without a write the table draws from
                    // its node again, as the moves drew over it.
                    const finish = (upEvent: MouseEvent) => {
                        win.removeEventListener('mouseup', finish);
                        win.removeEventListener('mousemove', move);
                        const at = columnDragKey.getState(view.state);
                        const current = at == null ? null : view.state.doc.nodeAt(at);
                        const tr = view.state.tr.setMeta(columnDragKey, null);
                        const widths = widthsAt(upEvent.clientX);
                        const changed = widths.some((width, index) => width !== start[index]);
                        if (at != null && current && changed && TableMap.get(current).width === widths.length) {
                            setColumnWidths(tr, current, at + 1, widths);
                        }
                        view.dispatch(tr);
                        const colgroup = dom.firstChild;
                        if (!tr.docChanged && current && colgroup instanceof HTMLTableColElement) {
                            updateColumnsOnResize(current, colgroup, dom, cellMinWidth);
                        }
                    };

                    view.dispatch(view.state.tr.setMeta(columnDragKey, tablePos));
                    win.addEventListener('mouseup', finish);
                    win.addEventListener('mousemove', move);
                    event.preventDefault();
                    return true;
                },
            },
        },
    });
}

// The docs editor's table. prosemirror-tables' own TableView, not TipTap's, because TipTap's leaves a column's dragged
// width drawn when an undo takes its colwidth back to none. `resizable` is off for a coarse pointer (editor.tsx).
export const EditorTable = Table.extend({
    addCommands() {
        return {
            ...this.parent?.(),
            // Google Docs' Distribute columns: one width for every column, splitting the table's own width, or the
            // widest the table draws when a column has none and the table draws at that width.
            distributeColumns:
                () =>
                ({ state, tr, dispatch, view }: CommandProps) => {
                    if (!isInTable(state)) return false;
                    const { map, table, tableStart } = selectedRect(state);
                    const stored = map.map
                        .slice(0, map.width)
                        .map(
                            (pos, col): number => table.nodeAt(pos)?.attrs['colwidth']?.[col - map.colCount(pos)] ?? 0,
                        );
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
