// A paste into the grid: cells copied in this tab with their formulas and formats, a cut that moves them, an HTML table
// from another program, plain text or a formula. The Workbook hands handlePaste the clipboard of a paste event, and a
// menu row reads the clipboard through pasteFromClipboard to do the same. The open cell editor takes its own paste, so
// none of it comes here. Each kind asks roomFor before its first write, which refuses it or grows the grid.

import { formatForDisplay } from '@tanstack/react-hotkeys';
import type { CellBorderSides } from '@workspace/lib/sheets';
import { BORDER_SIDE_CSS } from '@workspace/lib/sheets';
import { cloneDeep, isEmpty, isNil, times } from 'es-toolkit/compat';
import { MAX_SHEET_COLUMN_COUNT, MAX_SHEET_ROW_COUNT } from '../../engine/defaults';
import { writeFormulaResult } from '../../engine/format';
import { functionCopy } from '../../engine/formula-shift';
import type { CellMatrix } from '../../engine/types';
import { setRowHeight } from '../api';
import { getSheet } from '../api/common';
import type { Context } from '../context';
import { getSheetConfig } from '../context';
import { carrySides } from '../modules/border';
import type { CarryTile } from '../modules/carry';
import { carriedLines, carryCells, moveCells, movedLines } from '../modules/carry';
import { getQKBorder, setCellValue } from '../modules/cell';
import { computeFormula } from '../modules/formula-exec';
import { cellsIn, jfrefreshgrid, recomputeCells } from '../modules/refresh';
import { normalizeSelection } from '../modules/selection';
import { hasPartMC, PART_MERGE_REFUSAL } from '../modules/validation';
import type { FormulaCell } from '../types';
import { getSheetIndex } from '../utils';
import { SHEET_HOTKEYS } from './keyboard';
import { pastedCell, readStyleRules } from './paste-cell';

// What a paste reads of the clipboard: a paste event's DataTransfer, or one a menu row filled.
type PastedData = { getData: (type: string) => string; files: ArrayLike<File> };

// The one paste of the grid. It is the workbook's own copy only when the clipboard's table carries its id.
// An image file goes to the app's insert and upload.
export function handlePaste(ctx: Context, clipboardData: PastedData, onImageFile?: (file: File) => void) {
    if (ctx.allowEdit === false || (ctx.selections?.length ?? 0) > 1) return;
    ctx.editingCellPosition = [];

    const html = clipboardData.getData('text/html');
    const { copyState } = ctx;
    if (
        copyState &&
        html.includes(`data-copy-id="${copyState.id}"`) &&
        getSheetIndex(ctx, copyState.dataSheetId) != null
    ) {
        if (copyState.cut) pasteCut(ctx, copyState);
        else pasteCopy(ctx, copyState);
    } else if (/<table\b/i.test(html)) {
        pasteTable(ctx, html);
    } else if (clipboardData.files.length === 1 && clipboardData.files[0].type.startsWith('image')) {
        onImageFile?.(clipboardData.files[0]);
    } else {
        const text = clipboardData.getData('text/plain');
        if (text.startsWith('=')) pasteFormula(ctx, text);
        else if (text) pasteText(ctx, text);
    }
    normalizeSelection(ctx, ctx.selections);
}

// A menu row has no paste event, so it reads the clipboard itself and hands the paste what a ⌘V would have had. Where
// the browser refuses the read, or has no such read, it says to press the key, as Google Sheets does.
export async function pasteFromClipboard(
    paste: (clipboardData: DataTransfer) => void,
    showNotice: (text: string) => void,
) {
    const clipboardData = new DataTransfer();
    try {
        for (const item of await navigator.clipboard.read()) {
            for (const type of item.types) {
                const blob = await item.getType(type);
                if (type === 'text/html' || type === 'text/plain') clipboardData.setData(type, await blob.text());
                else if (type.startsWith('image/')) clipboardData.items.add(new File([blob], 'image', { type }));
            }
        }
    } catch {
        showNotice(`Your browser blocks Paste from a menu. Press ${formatForDisplay(SHEET_HOTKEYS.paste)} instead.`);
        return;
    }
    paste(clipboardData);
}

function pasteCut(ctx: Context, copyState: NonNullable<Context['copyState']>) {
    const copySheetId = copyState.dataSheetId;
    const sourceRange = copyState.copyRange[0];

    if (!getSheet(ctx, { id: copySheetId }).data) return;
    const lines = movedLines(ctx, copySheetId, sourceRange);
    if (!lines) return;

    const height = lines.rows.length;
    const width = lines.columns.length;

    const last = ctx.selections?.at(-1);
    if (!last || last.row_focus == null || last.column_focus == null) return;

    const top = last.row_focus;
    const bottom = top + height - 1;
    const left = last.column_focus;
    const right = left + width - 1;

    if (!roomFor(ctx, top, bottom, left, right)) return;

    moveCells(ctx, lines, sourceRange, { row: top, column: left, height, width });

    const targetRange = { row: [top, bottom], column: [left, right] };
    ctx.selections = [targetRange];
    recomputeCells(ctx, [...cellsIn(sourceRange, copySheetId), ...cellsIn(targetRange, ctx.currentSheetId)]);
    // A cut moves its cells once. The clipboard still holds them, and a next paste lands them as a table.
    ctx.copyState = undefined;
    ctx.formulaRangeSelections = [];
}

function pasteCopy(ctx: Context, copyState: NonNullable<Context['copyState']>) {
    const copySheetId = copyState.dataSheetId;
    const lines = carriedLines(ctx, copySheetId, copyState.copyRange);
    if (!lines) return;
    const height = lines.rows.length;
    const width = lines.columns.length;
    // A filter can hide every row of the copy.
    if (height === 0 || width === 0) return;

    const last = ctx.selections?.at(-1);
    if (!last) return;
    const top = last.row[0];
    let bottom = last.row[1];
    const left = last.column[0];
    let right = last.column[1];

    if ((bottom - top + 1) % height !== 0 || (right - left + 1) % width !== 0) {
        // A target that is not a whole multiple of the copy takes the copy's size.
        bottom = top + height - 1;
        right = left + width - 1;
    }

    if (!roomFor(ctx, top, bottom, left, right)) return;

    const tiles: CarryTile[] = [];
    for (let row = top; row <= bottom; row += height) {
        for (let column = left; column <= right; column += width) tiles.push({ row, column, height, width });
    }

    // A copy of several ranges pastes the values of its formulas, not the formulas.
    const several = copyState.copyRange.length > 1;
    const landed: FormulaCell[] = [];
    carryCells(ctx, lines, tiles, ({ source, r, c, sr, sc }) => {
        if (source?.f == null) return source;
        if (several) {
            const { f: _, ...value } = source;
            return value;
        }
        // A copy on its own cell is the same formula. Anywhere else it is a new one, so its source's value isn't its
        // own: it lands with none and this build's answer stands, even #NAME?. On a copy, as the write changes its ct.
        if (copySheetId === ctx.currentSheetId && r === sr && c === sc) return cloneDeep(source);
        const cell = { ...cloneDeep(source), f: `=${functionCopy(source.f, r - sr, c - sc)}` };
        writeFormulaResult(cell, undefined);
        landed.push({ r, c, id: ctx.currentSheetId });
        return cell;
    });

    last.row = [top, bottom];
    last.column = [left, right];

    recomputeCells(ctx, cellsIn({ row: last.row, column: last.column }, ctx.currentSheetId), landed);
}

// An HTML table from another program, or from a copy of another tab, with the cells' styles as the HTML carries them.
function pasteTable(ctx: Context, html: string) {
    const anchor = ctx.selections?.[0];
    if (!anchor) return;

    // Parse into an inert document, never a live <div>: a detached element's innerHTML still loads <img>.
    const parsed = new DOMParser().parseFromString(html, 'text/html');

    const trList = parsed.querySelectorAll('table tr');
    if (trList.length === 0) return;

    let colLen = 0;
    for (const td of trList[0].querySelectorAll('td')) colLen += td.colSpan;
    const data: CellMatrix = Array.from({ length: trList.length }, () => new Array(colLen));

    const borderInfo: Record<string, CellBorderSides> = {};
    const styleRules = readStyleRules(parsed.querySelector('style')?.textContent ?? '');
    const tableVerticalAlign = styleRules.get('td')?.['vertical-align'];

    const currentRowlen = getSheetConfig(ctx)?.rowlen ?? {};
    const rowHeights: Record<number, number> = {};
    for (const [r, tr] of [...trList].entries()) {
        let c = 0;
        const targetR = anchor.row[0] + r;

        const heightAttr = tr.getAttribute('height');
        if (!isNil(heightAttr)) {
            const targetRowHeight = parseInt(heightAttr, 10);
            if ((currentRowlen[targetR] ?? ctx.defaultrowlen) !== targetRowHeight) {
                rowHeights[targetR] = targetRowHeight;
            }
        }

        for (const td of tr.querySelectorAll('td')) {
            const styles = styleRules.get(`.${td.className}`) ?? {};
            if (!isNil(styles.border)) td.style.border = styles.border;
            const cell = pastedCell(td, styles, tableVerticalAlign);

            while (c < colLen && !isNil(data[r][c])) {
                c += 1;
            }
            if (c === colLen) break;

            data[r][c] = cell;
            // A span ends at the table's edge, as it does on the page.
            const rowspan = Math.min(td.rowSpan, data.length - r);
            const colspan = Math.min(td.colSpan, colLen - c);
            const anchorRow = anchor.row[0] + r;
            const anchorColumn = anchor.column[0] + c;

            for (let rp = 0; rp < rowspan; rp += 1) {
                for (let cp = 0; cp < colspan; cp += 1) {
                    const onEdge = {
                        t: rp === 0,
                        b: rp === rowspan - 1,
                        l: cp === 0,
                        r: cp === colspan - 1,
                    };
                    for (const [side, css] of BORDER_SIDE_CSS) {
                        const shorthand = onEdge[side] ? td.style.getPropertyValue(`border-${css}`) : '';
                        if (isEmpty(shorthand) || shorthand.slice(0, 3).toLowerCase() === '0px') continue;
                        (borderInfo[`${r + rp}_${c + cp}`] ??= {})[side] = getQKBorder(
                            td.style.getPropertyValue(`border-${css}-width`),
                            td.style.getPropertyValue(`border-${css}-style`),
                            td.style.getPropertyValue(`border-${css}-color`),
                        );
                    }

                    if (rp > 0 || cp > 0) data[r + rp][c + cp] = { mc: { r: anchorRow, c: anchorColumn } };
                }
            }

            if (rowspan > 1 || colspan > 1) cell.mc = { rs: rowspan, cs: colspan, r: anchorRow, c: anchorColumn };
            c += 1;
        }
    }
    ctx.formulaRangeSelections = [];

    const top = anchor.row[0];
    const bottom = top + data.length - 1;
    const left = anchor.column[0];
    const right = left + colLen - 1;
    const d = roomFor(ctx, top, bottom, left, right);
    if (!d) return;

    setRowHeight(ctx, rowHeights);
    clearCoveredMerges(ctx, d, top, bottom, left, right);
    const cfg = (getSheet(ctx).config ??= {});
    const merge = (cfg.merge ??= {});
    const borders = (cfg.borderInfo ??= {});
    for (let h = top; h <= bottom; h += 1) {
        for (let c = left; c <= right; c += 1) {
            const value = data[h - top][c - left] ?? null;
            d[h][c] = value;
            if (value?.mc?.rs != null) merge[`${h}_${c}`] = { r: h, c, rs: value.mc.rs, cs: value.mc.cs ?? 1 };
            carrySides(borders, h, c, borderInfo[`${h - top}_${c - left}`]);
        }
    }

    ctx.selections = [{ row: [top, bottom], column: [left, right] }];
    jfrefreshgrid(ctx);
}

// Plain text, tabs between columns and newlines between rows. A line with fewer columns than the first is left out.
function pasteText(ctx: Context, text: string) {
    const lines = text.replace(/\r/g, '').split('\n');
    const columns = lines[0].split('\t').length;
    const rows = lines.map((line) => line.split('\t')).filter((row) => row.length >= columns);

    const selection = ctx.selections?.[0];
    if (!selection) return;
    const top = selection.row[0];
    const left = selection.column[0];
    const bottom = top + rows.length - 1;
    const right = left + columns - 1;

    const d = roomFor(ctx, top, bottom, left, right);
    if (!d) return;
    clearCoveredMerges(ctx, d, top, bottom, left, right);

    for (const [r, row] of rows.entries()) {
        for (let c = 0; c < columns; c += 1) {
            const originCell = d[r + top][c + left];
            if (originCell?.f != null) delete originCell.f;
            setCellValue(ctx, r + top, c + left, d, row[c]);
        }
    }

    selection.row = [top, bottom];
    selection.column = [left, right];

    jfrefreshgrid(ctx);
}

function pasteFormula(ctx: Context, formulaStr: string) {
    const selection = ctx.selections?.[0];
    if (!selection) return;
    const r = selection.row[0];
    const c = selection.column[0];

    const [v, f] = computeFormula(ctx, formulaStr);
    setCellValue(ctx, r, c, null, { v, f });

    jfrefreshgrid(ctx, [{ row: [r, r], column: [c, c] }]);
}

// A paste replaces every merge it covers. roomFor has refused a paste that covers only part of one.
function clearCoveredMerges(ctx: Context, d: CellMatrix, top: number, bottom: number, left: number, right: number) {
    const merge = getSheet(ctx).config?.merge;
    for (let r = top; r <= bottom; r += 1) {
        for (let c = left; c <= right; c += 1) {
            const cell = d[r][c];
            if (!cell?.mc) continue;
            if (cell.mc.rs != null) delete merge?.[`${cell.mc.r}_${cell.mc.c}`];
            delete cell.mc;
        }
    }
}

// The grid a paste lands in, grown when the paste runs past it; undefined when the paste is refused, before any op.
// The sheet's size grows too, because a reader builds the grid at the stored size.
function roomFor(ctx: Context, top: number, bottom: number, left: number, right: number): CellMatrix | undefined {
    if (hasPartMC(ctx, top, bottom, left, right)) {
        ctx.warnDialog = PART_MERGE_REFUSAL;
        return undefined;
    }
    const sheet = getSheet(ctx);
    const { data } = sheet;
    if (!data) return undefined;

    const rowsToAdd = bottom + 1 - data.length;
    const columnsToAdd = right + 1 - data[0].length;
    if (rowsToAdd <= 0 && columnsToAdd <= 0) return data;

    if (bottom >= MAX_SHEET_ROW_COUNT) {
        ctx.warnDialog = `This action would increase the number of rows in the workbook above the limit of ${MAX_SHEET_ROW_COUNT}.`;
        return undefined;
    }
    if (right >= MAX_SHEET_COLUMN_COUNT) {
        ctx.warnDialog = `This action would increase the number of columns in the workbook above the limit of ${MAX_SHEET_COLUMN_COUNT}.`;
        return undefined;
    }

    for (const row of data) row.push(...times(Math.max(columnsToAdd, 0), () => null));
    const columns = data[0].length;
    for (let r = 0; r < rowsToAdd; r += 1) data.push(times(columns, () => null));
    sheet.row = data.length;
    sheet.column = columns;
    return data;
}
