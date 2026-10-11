import { type CommandProps, Extension } from '@tiptap/core';
import { Plugin } from '@tiptap/pm/state';
import { isInTable, selectedRect } from '@tiptap/pm/tables';
import { MIN_TABLE_COLUMN_PX } from '@workspace/lib/docs/eigendoc';
import { textColumnWidth } from './text-column';

declare module '@tiptap/core' {
    interface Commands<ReturnType> {
        tableWidthClamp: {
            distributeColumns: () => ReturnType;
        };
    }
}

const DEFAULT_CELL_WIDTH = 100;

export const TableWidthClamp = Extension.create({
    name: 'tableWidthClamp',

    addCommands() {
        const editor = this.editor;
        return {
            // Google Docs' Distribute columns: one width for every column, splitting the table's own width, or the
            // text column when a column has none and the table draws at the column's width.
            distributeColumns:
                () =>
                ({ state, tr, dispatch }: CommandProps) => {
                    if (!isInTable(state)) return false;
                    const { map, table, tableStart } = selectedRect(state);
                    const columnPx = textColumnWidth(editor.view.dom) ?? 0;
                    const widths = map.map
                        .slice(0, map.width)
                        .map(
                            (pos, col): number => table.nodeAt(pos)?.attrs['colwidth']?.[col - map.colCount(pos)] ?? 0,
                        );
                    const tableWidth = widths.every((width) => width > 0)
                        ? widths.reduce((sum, width) => sum + width, 0)
                        : columnPx;
                    const total = columnPx > 0 ? Math.min(tableWidth, columnPx) : tableWidth;
                    if (total <= 0) return false;
                    const width = Math.max(MIN_TABLE_COLUMN_PX, Math.floor(total / map.width));
                    if (dispatch) {
                        for (const pos of new Set(map.map)) {
                            const cell = table.nodeAt(pos);
                            if (!cell) continue;
                            const colwidth = Array.from({ length: cell.attrs['colspan'] }, () => width);
                            tr.setNodeMarkup(tableStart + pos, null, { ...cell.attrs, colwidth });
                        }
                    }
                    return true;
                },
        };
    },

    addProseMirrorPlugins() {
        const editor = this.editor;

        return [
            new Plugin({
                // A column dragged past the text column ends here too: the drag writes its width, and this scales it.
                appendTransaction(transactions, _oldState, newState) {
                    if (!transactions.some((tr) => tr.docChanged)) return null;

                    const maxWidth = textColumnWidth(editor.view.dom);
                    if (!maxWidth || maxWidth <= 0) return null;

                    const tr = newState.tr;
                    let modified = false;

                    newState.doc.descendants((node, pos) => {
                        if (node.type.name !== 'table') return;
                        const firstRow = node.firstChild;
                        if (!firstRow) return;

                        // Sum column widths from the first row
                        let totalWidth = 0;
                        for (let i = 0; i < firstRow.childCount; i++) {
                            const cell = firstRow.child(i);
                            const cw: number[] | null = cell.attrs.colwidth;
                            for (let j = 0; j < cell.attrs.colspan; j++) {
                                totalWidth += cw?.[j] || DEFAULT_CELL_WIDTH;
                            }
                        }

                        if (totalWidth <= maxWidth) return;

                        const scale = maxWidth / totalWidth;
                        const tableContentStart = pos + 1;

                        node.descendants((child, childPos) => {
                            if (child.type.name === 'table') return false;
                            if (child.type.name !== 'tableCell' && child.type.name !== 'tableHeader') return;
                            const cw: number[] | null = child.attrs.colwidth;
                            if (!cw) return false;
                            const scaled = cw.map((w) =>
                                w ? Math.max(MIN_TABLE_COLUMN_PX, Math.floor(w * scale)) : w,
                            );
                            if (scaled.some((w, i) => w !== cw[i])) {
                                modified = true;
                                tr.setNodeMarkup(tableContentStart + childPos, null, {
                                    ...child.attrs,
                                    colwidth: scaled,
                                });
                            }
                            return false;
                        });
                    });

                    return modified ? tr : null;
                },
            }),
        ];
    },
});
