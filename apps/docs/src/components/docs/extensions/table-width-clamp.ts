// TableWidthClamp keeps every table's stored widths within the page after any change in a writer's tab, a paste's or a
// collaborator's included. A table in the body keeps its widths, each column at most the paper's width, as a page-less
// doc's wide table scrolls sideways and keeps them when the doc goes back to pages. A table nested in a list item or a
// cell, or one in a header or a footer, which has no such strip, is fitted to the text column, every column scaled by
// one factor to a floor.

import { Extension } from '@tiptap/core';
import type { Node as PMNode } from '@tiptap/pm/model';
import { Plugin } from '@tiptap/pm/state';
import { columnFit } from '@workspace/lib/docs/eigendoc';

const DEFAULT_CELL_WIDTH = 100;

type TableWidthClampOptions = {
    textColumnWidth: () => number;
    paperWidth: () => number;
    // A header's or a footer's editor, whose tables are all fitted.
    band: boolean;
};

export const TableWidthClamp = Extension.create<TableWidthClampOptions>({
    name: 'tableWidthClamp',

    addOptions() {
        return { textColumnWidth: () => Infinity, paperWidth: () => Infinity, band: false };
    },

    addProseMirrorPlugins() {
        const editor = this.editor;
        const { textColumnWidth, paperWidth, band } = this.options;

        return [
            new Plugin({
                appendTransaction(transactions, _oldState, newState) {
                    // The server drops a viewer's writes, so a clamp in a viewer's tab would only part it from the doc.
                    if (!editor.isEditable || !transactions.some((tr) => tr.docChanged)) return null;

                    const tr = newState.tr;
                    let modified = false;
                    let maxWidth: number | undefined;
                    let maxColumnWidth: number | undefined;
                    // Rewrites the stored widths of each cell of the table at `pos`. A nested table is left to the
                    // walk below, which reaches it on its own.
                    const rewriteWidths = (table: PMNode, pos: number, next: (colwidth: number[]) => number[]) => {
                        table.descendants((child, childPos) => {
                            if (child.type.name === 'table') return false;
                            if (child.type.name !== 'tableCell' && child.type.name !== 'tableHeader') return;
                            const cw: number[] | null = child.attrs.colwidth;
                            if (!cw) return false;
                            const colwidth = next(cw);
                            if (colwidth.some((w, i) => w !== cw[i])) {
                                modified = true;
                                tr.setNodeMarkup(pos + 1 + childPos, null, { ...child.attrs, colwidth });
                            }
                            return false;
                        });
                    };

                    newState.doc.descendants((node, pos) => {
                        if (node.type.name !== 'table') return;
                        const firstRow = node.firstChild;
                        if (!firstRow) return;

                        if (!band && newState.doc.resolve(pos).depth === 0) {
                            maxColumnWidth ??= paperWidth();
                            const cap = maxColumnWidth;
                            rewriteWidths(node, pos, (cw) => cw.map((w) => Math.min(w, cap)));
                            return;
                        }
                        maxWidth ??= textColumnWidth();

                        let totalWidth = 0;
                        for (let i = 0; i < firstRow.childCount; i++) {
                            const cell = firstRow.child(i);
                            const cw: number[] | null = cell.attrs.colwidth;
                            for (let j = 0; j < cell.attrs.colspan; j++) {
                                totalWidth += cw?.[j] || DEFAULT_CELL_WIDTH;
                            }
                        }

                        if (totalWidth <= maxWidth) return;

                        const fit = columnFit(maxWidth, totalWidth);
                        rewriteWidths(node, pos, (cw) => cw.map((w) => (w ? fit(w) : w)));
                    });

                    return modified ? tr : null;
                },
            }),
        ];
    },
});
