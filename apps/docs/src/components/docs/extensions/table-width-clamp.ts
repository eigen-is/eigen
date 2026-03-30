import { Extension } from '@tiptap/core';
import { Plugin } from '@tiptap/pm/state';

const DEFAULT_CELL_WIDTH = 100;
const MIN_CELL_WIDTH = 25;

export const TableWidthClamp = Extension.create({
    name: 'tableWidthClamp',

    addProseMirrorPlugins() {
        const editor = this.editor;

        return [
            new Plugin({
                appendTransaction(transactions, _oldState, newState) {
                    if (!transactions.some((tr) => tr.docChanged)) return null;

                    const container = editor.view.dom.closest('[data-document]');
                    if (!container) return null;
                    const cs = getComputedStyle(container);
                    const maxWidth = container.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
                    if (maxWidth <= 0) return null;

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
                            const cw = cell.attrs.colwidth as number[] | null;
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
                            const cw = child.attrs.colwidth as number[] | null;
                            if (!cw) return false;
                            const scaled = cw.map((w) => (w ? Math.max(MIN_CELL_WIDTH, Math.floor(w * scale)) : w));
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
