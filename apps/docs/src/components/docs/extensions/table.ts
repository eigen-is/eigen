import { Table } from '@tiptap/extension-table';
import type { Node as PMNode } from '@tiptap/pm/model';
import { Plugin } from '@tiptap/pm/state';
import { columnResizingPluginKey, TableMap, TableView } from '@tiptap/pm/tables';
import type { EditorView } from '@tiptap/pm/view';
import { MIN_TABLE_COLUMN_PX } from '@workspace/lib/docs/eigendoc';
import { textColumnWidth } from './text-column';

const sum = (widths: number[]) => widths.reduce((total, width) => total + width, 0);
const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max);

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

// Every cell of the dragged table takes its columns' widths, read again from the state at the drop, where a
// collaborator's edit may have moved the table; a table whose columns changed meanwhile keeps its widths.
function writeWidths(view: EditorView, widths: number[]) {
    const handle = columnResizingPluginKey.getState(view.state)?.activeHandle ?? -1;
    if (handle < 0) return;
    const $cell = view.state.doc.resolve(handle);
    const table = $cell.node(-1);
    const tableStart = $cell.start(-1);
    const map = TableMap.get(table);
    if (map.width !== widths.length) return;
    const tr = view.state.tr;
    for (const pos of new Set(map.map)) {
        const cell = table.nodeAt(pos);
        if (!cell) continue;
        const first = map.colCount(pos);
        const colwidth = widths.slice(first, first + cell.attrs['colspan']);
        const old: number[] | null = cell.attrs['colwidth'];
        if (old && colwidth.every((width, k) => width === old[k])) continue;
        tr.setNodeMarkup(tableStart + pos, null, { ...cell.attrs, colwidth });
    }
    if (tr.docChanged) view.dispatch(tr);
}

// Takes over columnResizing's drag from mousedown to mouseup and keeps the rest of it: the hover that finds the border,
// its handle and cursor, and the `dragging` state they draw from. Its own drag sets one column, so a table that fills
// the text column could only grow; this one moves width between the border's two columns instead. The first drag
// stores every column's width, so none is left to the layout.
function columnDrag() {
    return new Plugin({
        props: {
            handleDOMEvents: {
                mousedown(view, event) {
                    const handle = columnResizingPluginKey.getState(view.state);
                    if (!view.editable || !handle || handle.activeHandle < 0 || handle.dragging) return false;
                    const $cell = view.state.doc.resolve(handle.activeHandle);
                    const table = $cell.node(-1);
                    const tableStart = $cell.start(-1);
                    const map = TableMap.get(table);
                    const col = map.colCount($cell.pos - tableStart) + ($cell.nodeAfter?.attrs['colspan'] ?? 1) - 1;
                    let tableDom: Node | null = view.domAtPos(tableStart).node;
                    while (tableDom && !(tableDom instanceof HTMLTableElement)) tableDom = tableDom.parentNode;
                    if (!tableDom) return false;
                    const dom = tableDom;

                    const start = columnWidths(view, table, tableStart, map);
                    const maxTableWidth = textColumnWidth(view.dom) || Infinity;
                    // The page may be drawn scaled; widths are in the page's own pixels.
                    const scale = dom.offsetWidth > 0 ? dom.getBoundingClientRect().width / dom.offsetWidth : 1;
                    const widthsAt = (clientX: number) =>
                        draggedWidths(start, col, (clientX - event.clientX) / scale, maxTableWidth);

                    const win = view.dom.ownerDocument.defaultView ?? window;
                    const move = (moveEvent: MouseEvent) => {
                        if (!moveEvent.buttons) return finish(moveEvent);
                        drawColumns(dom, widthsAt(moveEvent.clientX));
                    };
                    const finish = (upEvent: MouseEvent) => {
                        win.removeEventListener('mouseup', finish);
                        win.removeEventListener('mousemove', move);
                        writeWidths(view, widthsAt(upEvent.clientX));
                        view.dispatch(view.state.tr.setMeta(columnResizingPluginKey, { setDragging: null }));
                    };

                    view.dispatch(
                        view.state.tr.setMeta(columnResizingPluginKey, {
                            setDragging: { startX: event.clientX, startWidth: start[col] },
                        }),
                    );
                    drawColumns(dom, start);
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
    addProseMirrorPlugins() {
        const plugins = this.parent?.() ?? [];
        return this.options.resizable && this.editor.isEditable ? [columnDrag(), ...plugins] : plugins;
    },
}).configure({ resizable: true, cellMinWidth: MIN_TABLE_COLUMN_PX, View: TableView });
