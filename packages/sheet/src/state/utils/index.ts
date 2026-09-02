import { parseCellKey } from '@workspace/lib/sheets';
import { every, isNil, isNumber, isUndefined, kebabCase, map } from 'es-toolkit/compat';
import { type Context, getFlowdata, getSheetConfig } from '../context';
import { checkCellIsLocked } from '../modules';
import type { Selection, Sheet } from '../types';

export * from './patch';

export function generateRandomSheetName(file: Sheet[], isPivotTable: boolean) {
    let index = file.length;

    const title = 'Pivot Table';

    for (let i = 0; i < file.length; i += 1) {
        if (file[i].name.indexOf('Sheet') > -1 || file[i].name.indexOf(title) > -1) {
            const suffix = parseFloat(file[i].name.replace('Sheet', '').replace(title, ''));

            if (!Number.isNaN(suffix) && Math.ceil(suffix) > index) {
                index = Math.ceil(suffix);
            }
        }
    }

    if (isPivotTable) {
        return title + (index + 1);
    }
    return `Sheet${index + 1}`;
}

// color: convert rgb to hex
export function rgbToHex(color: string): string {
    const stripped = color.indexOf('rgba') > -1 ? color.replace('rgba(', '') : color.replace('rgb(', '');
    const rgb = stripped.replace(')', '').split(',');

    const r = Number(rgb[0]);
    const g = Number(rgb[1]);
    const b = Number(rgb[2]);

    return `#${((1 << 24) + (r << 16) + (g << 8) + b).toString(16).slice(1)}`;
}

// column index: number to letter
export function indexToColumnChar(n: number) {
    const orda = 'a'.charCodeAt(0);
    const ordz = 'z'.charCodeAt(0);
    const len = ordz - orda + 1;
    let s = '';
    while (n >= 0) {
        s = String.fromCharCode((n % len) + orda) + s;
        n = Math.floor(n / len) - 1;
    }
    return s.toUpperCase();
}

// column index: letter to number
export function columnCharToIndex(a: string) {
    if (a == null || a.length === 0) {
        return NaN;
    }
    const str = a.toLowerCase().split('');
    const al = str.length;
    const getCharNumber = (charx: string) => {
        return charx.charCodeAt(0) - 96;
    };
    let numout = 0;
    let charnum = 0;
    for (let i = 0; i < al; i += 1) {
        charnum = getCharNumber(str[i]);
        numout += charnum * 26 ** (al - i - 1);
    }
    if (numout === 0) {
        return NaN;
    }
    return numout - 1;
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
    for (let i = 0; i < ctx.sheets.length; i += 1) {
        if (ctx.sheets[i].name === name) {
            return ctx.sheets[i].id;
        }
    }
    return null;
}

export function getSheetByIndex(ctx: Context, id: string) {
    if (isNil(id)) {
        id = ctx.currentSheetId;
    }
    const i = getSheetIndex(ctx, id);
    if (isNil(i)) {
        return null;
    }
    return ctx.sheets[i];
}

// get the current date and time
export function getNowDateTime(format: number) {
    const now = new Date();
    const year = now.getFullYear(); // year
    let month: string | number = now.getMonth(); // month
    let date: string | number = now.getDate(); // day
    let hour: string | number = now.getHours(); // hour
    let minu: string | number = now.getMinutes(); // minute
    let sec: string | number = now.getSeconds(); // second

    month += 1;
    if (month < 10) month = `0${month}`;
    if (date < 10) date = `0${date}`;
    if (hour < 10) hour = `0${hour}`;
    if (minu < 10) minu = `0${minu}`;
    if (sec < 10) sec = `0${sec}`;

    let time = '';

    // date
    if (format === 1) {
        time = `${year}-${month}-${date}`;
    }
    // date and time
    else if (format === 2) {
        time = `${year}-${month}-${date} ${hour}:${minu}:${sec}`;
    }

    return time;
}

// A cell style object (getStyleByCell / getFontStyleByCell) as an inline CSS
// declaration list. Both HTML producers in this package — the clipboard table in
// modules/selection.ts and the rich-text runs in modules/cell.ts — wrote the same
// three lines by hand, and only one of them was ever hardened. Callers escape the
// result themselves: both halves come from the cell, and a colour like
// `red' onload='…` would otherwise close the style attribute and open an event
// handler. Numeric values are the pixel ones (font size, indent).
export function styleObjectToCss(style: Record<string, string>): string {
    return map(style, (v, key) => `${kebabCase(key)}:${isNumber(v) ? `${v}px` : v};`).join('');
}

// Replace ${xxx} placeholders in `temp` (an HTML/string template) with values
// from `dataarry`. Keys not present in `dataarry` are left in place verbatim.
export function replaceHtml(temp: string, dataarry: Record<string, string | number>): string {
    return temp.replace(/\$\{([\w]+)\}/g, (s1, s2) => {
        const s = dataarry[s2];
        if (typeof s !== 'undefined') {
            return String(s);
        }
        return s1;
    });
}

export function isAllowEdit(ctx: Context, range?: Sheet['selections']) {
    const cfg = getSheetConfig(ctx);
    const judgeRange = isUndefined(range) ? ctx.selections : range;
    return (
        every(judgeRange, (selection) => {
            for (let r = selection.row[0]; r <= selection.row[1]; r += 1) {
                if (cfg?.rowReadOnly?.[r]) {
                    return false;
                }
            }
            for (let c = selection.column[0]; c <= selection.column[1]; c += 1) {
                if (cfg?.colReadOnly?.[c]) {
                    return false;
                }
            }

            for (let r = selection.row[0]; r <= selection.row[1]; r += 1) {
                for (let c = selection.column[0]; c <= selection.column[1]; c += 1) {
                    if (checkCellIsLocked(ctx, r, c, ctx.currentSheetId)) {
                        return false;
                    }
                }
            }

            return true;
        }) && (isUndefined(ctx.allowEdit) ? true : ctx.allowEdit)
    );
}

// A click on a row or column header hands over every row or column the sheet has
// (events/mouse-header.ts), and per-cell writes over 130k rows are a quarter of a million
// immer patches for the collab layer to turn into Yjs ops. A whole-sheet axis is clipped
// to the last cell holding something; a range the user dragged out is applied as selected.
//
// "Whole axis" is read from the header-select flags, never from the extent: a whole-column
// header selection carries `column_select` (spans every row → clip its rows), a whole-row one
// carries `row_select` (spans every column → clip its columns); `selectAll` sets both. These
// flags are set ONLY by the header click/drag paths and selectAll, so a hand-dragged A1:Z100
// range on a default 26-column sheet — which happens to span the visible column axis — is no
// longer misread as whole-axis and silently clipped.
export function clipToUsedExtent(ctx: Context, selections: Selection[]): Selection[] {
    const wholeRows = selections.map((s) => s.column_select === true);
    const wholeColumns = selections.map((s) => s.row_select === true);
    const d = getFlowdata(ctx);
    if (!d || (!wholeRows.includes(true) && !wholeColumns.includes(true))) return selections;

    // The DATA extent is sheet-wide on purpose, NOT bounded to the selection's axis: a header
    // click on an empty column still reaches the last row that holds data in any column, and a
    // click on an empty row the last column with data in any row (pinned by border.test.ts
    // "bounds a header-click selection to the used extent"). Both scans already early-exit from
    // the far edge, so there is no cheap trim to make here without an index — and a cached extent
    // is out of scope. Only the bordered-extent pass below is axis-aware.
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
    // A bordered blank cell is used content too, but only along the selection's fixed axis: a
    // whole-column selection extends its rows for borders in its own columns, a whole-row
    // selection its columns for borders in its own rows. A border elsewhere is not "its" content
    // — counting it would seed insertCheckbox/border-all thousands of cells past the data.
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
