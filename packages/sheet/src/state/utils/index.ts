// Small helpers the sheet's state modules share, such as finding a sheet by id or name, a new sheet's name and a color
// as hex. The op-to-patch translation and the check whether two sets of op batches commute live beside them and are
// re-exported here.

import { parseRgb } from '@workspace/lib/constants/colors';
import { parseCellKey } from '@workspace/lib/sheets';
import { isNumber, kebabCase, map } from 'es-toolkit/compat';
import { findSheetByName } from '../../engine/a1-notation';
import type { Context } from '../context';
import { getFlowdata, getSheetConfig } from '../context';
import type { Selection, Sheet } from '../types';

export * from './commute';
export * from './patch';

export function nextSheetName(sheets: Sheet[]) {
    let index = sheets.length;
    for (const { name } of sheets) {
        const suffix = Math.ceil(parseFloat(name.replace('Sheet', '')));
        if (name.includes('Sheet') && suffix > index) index = suffix;
    }
    return `Sheet${index + 1}`;
}

// A browser's rgb() or rgba() as the #rrggbb the sheet stores, its alpha dropped. Any other color comes back as it is.
export function rgbToHex(color: string): string {
    return parseRgb(color)?.hex ?? color;
}

// A sheet without an order sorts as 0. Every reader of a sheet's place asks here, so the tab strip, find and an add
// or a delete agree on where it is.
export function sheetOrder(sheet: Sheet): number {
    return sheet.order ?? 0;
}

export function getSheetIndex(ctx: Context, id: string) {
    for (let i = 0; i < ctx.sheets.length; i += 1) {
        if (ctx.sheets[i]?.id === id) {
            return i;
        }
    }
    return null;
}

export function getSheetIdByName(ctx: Context, name: string) {
    return findSheetByName(ctx.sheets, name)?.id ?? null;
}

// The sheet with this id, or undefined. getSheet in the API is the one that throws for a missing sheet.
export function findSheet(ctx: Context, id: string) {
    return ctx.sheets.find((sheet) => sheet.id === id);
}

// A cell style object as an inline CSS declaration list, with numbers as pixels. A caller escapes the result, because
// its values come from the cell, and a color can hold a quote that closes the style attribute.
export function styleObjectToCss(style: Record<string, string>): string {
    return map(style, (v, key) => `${kebabCase(key)}:${isNumber(v) ? `${v}px` : v};`).join('');
}

// Fills ${name} slots in a template, and leaves a slot it has no value for as it is.
export function replaceHtml(temp: string, dataarry: Record<string, string | number>): string {
    return temp.replace(/\$\{([\w]+)\}/g, (s1, s2) => {
        const s = dataarry[s2];
        if (typeof s !== 'undefined') {
            return String(s);
        }
        return s1;
    });
}

// A whole row or column stops at its last used cell, or writing it would ship a patch per cell.
// A dragged range stays as selected.
export function clipToUsedExtent(ctx: Context, selections: Selection[]): Selection[] {
    const wholeRows = selections.map((s) => s.column_select === true);
    const wholeColumns = selections.map((s) => s.row_select === true);
    const d = getFlowdata(ctx);
    if (!d || (!wholeRows.includes(true) && !wholeColumns.includes(true))) return selections;

    // The extent of the data is sheet-wide, so a click on an empty column still reaches the last row with data.
    let lastRow = d.length - 1;
    while (lastRow > 0 && !d[lastRow]?.some((cell) => cell != null)) lastRow -= 1;
    let lastColumn = 0;
    if (wholeColumns.includes(true)) {
        for (let r = 0; r <= lastRow; r += 1) {
            const row = d[r];
            if (!row) continue;
            for (let c = row.length - 1; c > lastColumn; c -= 1) {
                if (row[c] == null) continue;
                lastColumn = c;
                break;
            }
        }
    }
    // A border counts only along the selection's own axis. One elsewhere would seed a tick box or border thousands of
    // cells past the data.
    const rowClipCols = selections.filter((_, i) => wholeRows[i]).map((s) => s.column);
    const colClipRows = selections.filter((_, i) => wholeColumns[i]).map((s) => s.row);
    const borderInfo = getSheetConfig(ctx)?.borderInfo;
    for (const key in borderInfo) {
        const [r, c] = parseCellKey(key);
        if (r > lastRow && rowClipCols.some(([c0, c1]) => c >= c0 && c <= c1)) lastRow = r;
        if (c > lastColumn && colClipRows.some(([r0, r1]) => r >= r0 && r <= r1)) lastColumn = c;
    }
    return selections.map((selection, i) => ({
        ...selection,
        row: wholeRows[i] ? [selection.row[0], lastRow] : selection.row,
        column: wholeColumns[i] ? [selection.column[0], lastColumn] : selection.column,
    }));
}
