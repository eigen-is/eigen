// The grid's side of the system clipboard. A copy or a cut of cells builds what the clipboard carries, an HTML table of
// the cells' values and styles and the same cells as TSV, and keeps it here as the pending copy. The Workbook's copy
// listener takes it and puts it on the clipboard. A menu row has no copy event of its own, so it fires one, for cells
// and for a selected image or chart alike.

import { cellsToTsv } from '@workspace/lib/clipboard';
import { escapeHtml } from '@workspace/lib/html';
import { borderSidesToCss, mergedBorderSides } from '@workspace/lib/sheets';
import { numberText } from '../../engine/format';
import type { Context } from '../context';
import type { CellMatrix } from '../types';
import { getSheetIndex, styleObjectToCss } from '../utils';
import { carriedLines } from './carry';
import { getCellValue, getStyleByCell } from './cell';
import { getComputeMap } from './condition-format';
import { hexColor } from './inline-string';

// Marks clipboard HTML as copied from a sheet.
export const COPY_ACTION_TABLE_MARKER = 'sheet-copy-action-table';

type PendingCopy = { html: string; plainText: string; cellText: string };

let pending: PendingCopy | null = null;

export function consumePendingCopy(): PendingCopy | null {
    const result = pending;
    pending = null;
    return result;
}

// A copy from a menu runs outside a copy event, so the browser would not write the clipboard. execCommand('copy')
// fires one, whose listener writes every MIME type, the Eigen ones included, which navigator.clipboard.write cannot.
export function flushPendingCopy() {
    if (pending == null) return;
    document.execCommand('copy');
}

// A selected image or chart writes itself in the Workbook's copy and cut listener, which a menu row reaches through
// the event execCommand fires, so a menu copies and cuts the way ⌘C and ⌘X do.
export function copyActiveObject(cut: boolean) {
    document.execCommand(cut ? 'cut' : 'copy');
}

// A copy or cut of the selection, hidden cells too, as a paste in this tab would land them. The Eigen text item holds
// the text unquoted, since a consumer reads it as text rather than as TSV.
export function copy(ctx: Context, { cut = false }: { cut?: boolean } = {}) {
    const ranges = ctx.selections ?? [];
    const sheetId = ctx.currentSheetId;
    const index = getSheetIndex(ctx, sheetId);
    if (index == null) return;
    const sheet = ctx.sheets[index];
    const d = sheet.data;
    if (!d) return;
    const lines = carriedLines(ctx, sheetId, ranges);
    if (!lines) return;
    const { rows, columns } = lines;

    const rect: [number, number, number, number] = [Infinity, -Infinity, Infinity, -Infinity];
    for (const range of ranges) {
        rect[0] = Math.min(rect[0], range.row[0]);
        rect[1] = Math.max(rect[1], range.row[1]);
        rect[2] = Math.min(rect[2], range.column[0]);
        rect[3] = Math.max(rect[3], range.column[1]);
    }
    // A td spans its merge, so the perimeter is read off the master.
    const borderInfoCompute = mergedBorderSides(sheet.config?.borderInfo, sheet.config?.merge, rect);
    const cfCompute = getComputeMap(ctx);

    let colgroup = '';
    let body = '';
    const text: string[][] = [];

    for (const [i, r] of rows.entries()) {
        body += '<tr>';
        const textRow: string[] = [];
        text.push(textRow);

        for (const [j, c] of columns.entries()) {
            if (i === 0) {
                colgroup += `<colgroup width="${finiteOr(sheet.config?.columnlen?.[c], 72)}px"></colgroup>`;
            }

            const cell = d[r]?.[c];
            // A merge writes one td, so the other cells it covers have none.
            if (cell?.mc && cell.mc.rs == null) {
                textRow.push('');
                continue;
            }

            let style = j === 0 ? `height:${finiteOr(sheet.config?.rowlen?.[r], 19)}px;` : '';
            if (cell) style += styleObjectToCss(getStyleByCell(ctx, d, r, c, cfCompute));
            const border = borderInfoCompute[`${r}_${c}`];
            // A border's color comes from a collaborator or an xlsx, so only a plain color reaches the copied HTML.
            if (border) {
                for (const decl of borderSidesToCss(border, (color) => hexColor(color) ?? 'transparent')) {
                    style += `${decl};`;
                }
            }
            const span = cell?.mc ? `rowspan="${finiteOr(cell.mc.rs, 1)}" colspan="${finiteOr(cell.mc.cs, 1)}"` : '';

            const shown = copiedCellText(d, r, c);
            textRow.push(shown);
            // The style lands inside an attribute, which the HTML parser decodes before CSS sees it.
            body += `<td ${span} style="${escapeHtml(style)}">${escapeHtml(shown)}</td>`;
        }

        body += '</tr>';
    }

    const id = crypto.randomUUID();
    const copyRange = ranges.map(({ row, column }) => ({ row, column }));
    ctx.formulaRangeSelections = copyRange;
    // The engine's own clipboard: the copied ranges, which a paste in this tab reads back from the live cells.
    ctx.copyState = { id, cut, dataSheetId: sheetId, copyRange };
    pending = {
        html: `<table data-type="${COPY_ACTION_TABLE_MARKER}" data-copy-id="${id}">${colgroup}${body}</table>`,
        plainText: cellsToTsv(text),
        cellText: text.map((row) => row.join('\t')).join('\n'),
    };
}

// A stored row height, column width or merge span can be any value a collaborator wrote.
function finiteOr(value: unknown, fallback: number): number {
    return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

// The text a copy writes for a cell, in its td and in the TSV. A width format such as w0 shows the raw value, and
// every other cell its display text.
function copiedCellText(d: CellMatrix, r: number, c: number): string {
    const cell = d[r]?.[c];
    if (cell == null) return '';
    if (/^(w|W)((0?)|(0\.0+))$/.test(cell.ct?.fa ?? '')) return String(getCellValue(r, c, d) ?? '');
    // General cuts a number to 11 characters; the clipboard carries Excel's 15 significant digits instead.
    if (typeof cell.v === 'number' && (cell.ct?.fa ?? 'General') === 'General') return numberText(cell.v);
    return String(getCellValue(r, c, d, 'm') ?? getCellValue(r, c, d) ?? '');
}
