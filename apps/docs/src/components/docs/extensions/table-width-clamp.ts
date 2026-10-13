import { Extension } from '@tiptap/core';
import { Plugin } from '@tiptap/pm/state';
import { MIN_TABLE_COLUMN_PX } from '@workspace/lib/docs/eigendoc';
import { textColumnWidth } from './text-column';

const DEFAULT_CELL_WIDTH = 100;

export const TableWidthClamp = Extension.create({
    name: 'tableWidthClamp',

    addProseMirrorPlugins() {
        const editor = this.editor;

        return [
            new Plugin({
                appendTransaction(transactions, _oldState, newState) {
                    // The server drops a viewer's writes, so a clamp in a viewer's tab would only part it from the doc.
                    if (!editor.isEditable || !transactions.some((tr) => tr.docChanged)) return null;

                    const tr = newState.tr;
                    let modified = false;
                    // A layout read, so made once a table is found.
                    let maxWidth: number | null | undefined;

                    newState.doc.descendants((node, pos) => {
                        if (node.type.name !== 'table') return;
                        const firstRow = node.firstChild;
                        if (!firstRow) return;
                        if (maxWidth === undefined) maxWidth = textColumnWidth(editor.view.dom);
                        if (maxWidth === null) return false;

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
