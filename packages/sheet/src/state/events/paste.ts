// A paste into the grid: cells copied in this tab with their formulas and formats, a cut that moves them, an HTML table
// from another program, plain text or a formula. The Workbook hands handlePaste the clipboard of a paste event, and a
// menu row reads the clipboard through pasteFromClipboard to do the same. The open cell editor takes its own paste, so
// none of it comes here. Each kind asks roomFor before its first write, which refuses it or grows the grid.

import { formatForDisplay } from '@tanstack/react-hotkeys';
import { bundledFontOfStack, readCssFontSize } from '@workspace/lib/constants/fonts';
import type { CellBorderSides } from '@workspace/lib/sheets';
import { BORDER_SIDE_CSS, SHEET_DEFAULT_FONT_SIZE } from '@workspace/lib/sheets';
import { includes, isEmpty, isNil, times, trim } from 'es-toolkit/compat';
import { createArrayResolver } from '../../engine/cell-resolver';
import { MAX_SHEET_COLUMN_COUNT, MAX_SHEET_ROW_COUNT } from '../../engine/defaults';
import { numberDisplay, parseCellInput } from '../../engine/format';
import type { Cell, CellMatrix } from '../../engine/types';
import { setRowHeight } from '../api';
import { getSheet } from '../api/common';
import type { Context } from '../context';
import { getFlowdata, getSheetConfig } from '../context';
import { carrySides } from '../modules/border';
import type { CarryTile } from '../modules/carry';
import { carriedLines, carryCells, landedCell, moveCells, movedLines } from '../modules/carry';
import { getQKBorder, setCellValue } from '../modules/cell';
import { computeFormula } from '../modules/formula-exec';
import { cellsIn, jfrefreshgrid, recomputeCells } from '../modules/refresh';
import { hasPartMC, PART_MERGE_REFUSAL } from '../modules/validation';
import { getSheetIndex } from '../utils';
import { SHEET_HOTKEYS } from './keyboard';

// What a paste reads of the clipboard: a paste event's DataTransfer, or one a menu row filled.
type PastedData = { getData: (type: string) => string; files: ArrayLike<File> };

// The one paste of the grid. It is the workbook's own copy only when the clipboard's table carries its id.
// An image file goes to the app's insert and upload.
export function handlePaste(ctx: Context, clipboardData: PastedData, onImageFile?: (file: File) => void) {
    // A paste into several ranges is not supported.
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

    const copySheet = getSheet(ctx, { id: copySheetId });
    if (!copySheet.data) return;
    const lines = movedLines(ctx, copySheetId, sourceRange);
    if (!lines) return;

    const height = lines.rows.length;
    const width = lines.columns.length;

    const last = ctx.selections?.[ctx.selections.length - 1];
    if (!last || last.row_focus == null || last.column_focus == null) return;

    const top = last.row_focus;
    const bottom = top + height - 1;
    const left = last.column_focus;
    const right = left + width - 1;

    const d = roomFor(ctx, top, bottom, left, right);
    if (!d) return;

    moveCells(ctx, lines, sourceRange, { row: top, column: left, height, width });

    const targetRange = { row: [top, bottom], column: [left, right] };
    ctx.selections = [targetRange];
    recomputeCells(ctx, [...cellsIn(sourceRange, copySheetId), ...cellsIn(targetRange, ctx.currentSheetId)]);
    // A cut moves its cells once. The clipboard still holds them, and a next paste lands them as a table.
    ctx.copyState = undefined;
    ctx.formulaRangeSelections = [];
}

function pasteCopy(ctx: Context, copyState: NonNullable<Context['copyState']>) {
    // One live resolver per paste, so each evaluation sees the cells pasted before it.
    const resolver = createArrayResolver(ctx.sheets);

    const copySheetId = copyState.dataSheetId;
    const lines = carriedLines(ctx, copySheetId, copyState.copyRange);
    if (!lines) return;
    const copyh = lines.rows.length;
    const copyc = lines.columns.length;
    // A filter can hide every row of the copy.
    if (copyh === 0 || copyc === 0) return;

    const last = ctx.selections?.[ctx.selections.length - 1];
    if (!last) return;
    const minh = last.row[0];
    let maxh = last.row[1];
    const minc = last.column[0];
    let maxc = last.column[1];

    const mh = (maxh - minh + 1) % copyh;
    const mc = (maxc - minc + 1) % copyc;

    if (mh !== 0 || mc !== 0) {
        // A target that is not a whole multiple of the copy takes the copy's size.
        maxh = minh + copyh - 1;
        maxc = minc + copyc - 1;
    }

    const d = roomFor(ctx, minh, maxh, minc, maxc);
    if (!d) return;

    const timesH = (maxh - minh + 1) / copyh;
    const timesC = (maxc - minc + 1) / copyc;

    const tiles: CarryTile[] = [];
    for (let th = 0; th < timesH; th += 1) {
        for (let tc = 0; tc < timesC; tc += 1) {
            tiles.push({ row: minh + th * copyh, column: minc + tc * copyc, height: copyh, width: copyc });
        }
    }

    // A copy of several ranges pastes the values of its formulas, not the formulas.
    const several = copyState.copyRange.length > 1;
    carryCells(ctx, lines, tiles, ({ source, r, c, sr, sc }) => {
        if (source?.f == null || !several) return landedCell(ctx, source, r - sr, c - sc, resolver);
        const { f: _, ...value } = source;
        return value;
    });

    last.row = [minh, maxh];
    last.column = [minc, maxc];

    jfrefreshgrid(ctx);
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
    const tdVerticalAlign = styleRules.get('td')?.['vertical-align'];

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
            const cell: Cell = {};
            const txt = td.innerText || td.innerHTML;
            if (trim(txt).length === 0) {
                cell.v = undefined;
                cell.m = '';
            } else {
                const mask = parseCellInput(txt);
                [cell.m, cell.ct, cell.v] = mask;
            }
            const styles = styleRules.get(`.${td.className}`) ?? {};
            if (!isNil(styles.border)) td.style.border = styles.border;
            let bg: string | undefined = td.style.backgroundColor || styles.background;
            if (bg === 'rgba(0, 0, 0, 0)' || isEmpty(bg)) bg = undefined;
            cell.bg = bg;

            const fontWeight = td.style.fontWeight;
            cell.bl =
                (fontWeight === '400' || fontWeight === 'normal' || isEmpty(fontWeight)) &&
                !includes(styles['font-style'], 'bold') &&
                (!styles['font-weight'] || styles['font-weight'] === '400')
                    ? 0
                    : 1;

            cell.it =
                (td.style.fontStyle === 'normal' || isEmpty(td.style.fontStyle)) &&
                !includes(styles['font-style'], 'italic')
                    ? 0
                    : 1;

            cell.un =
                includes(td.style.textDecoration, 'underline') || includes(styles['text-decoration'], 'underline')
                    ? 1
                    : undefined;

            cell.cl =
                includes(td.innerHTML, '<s>') ||
                includes(td.style.textDecoration, 'line-through') ||
                includes(styles['text-decoration'], 'line-through')
                    ? 1
                    : undefined;

            const ff = bundledFontOfStack(td.style.fontFamily || styles['font-family'] || '');
            if (ff) cell.ff = ff;
            cell.fs =
                readCssFontSize(td.style.fontSize) ??
                readCssFontSize(styles['font-size'] ?? '') ??
                SHEET_DEFAULT_FONT_SIZE;

            cell.fc = td.style.color || styles.color;

            // A cell without one is left to its value, so a number lands on the right.
            const ht = td.style.textAlign || styles['text-align'];
            if (ht === 'center') cell.ht = 0;
            else if (ht === 'right') cell.ht = 2;
            else if (ht === 'left') cell.ht = 1;

            const vt = td.style.verticalAlign || styles['vertical-align'] || tdVerticalAlign || 'top';
            if (vt === 'middle') {
                cell.vt = 0;
            } else if (vt === 'top' || vt === 'text-top') {
                cell.vt = 1;
            } else {
                cell.vt = 2;
            }

            if ('mso-rotate' in styles) cell.rt = parseFloat(styles['mso-rotate']);

            while (c < colLen && !isNil(data[r][c])) {
                c += 1;
            }
            if (c === colLen) break;

            data[r][c] = cell;
            // A span ends at the table's edge, as it does on the page.
            const rowspan = Math.min(td.rowSpan, data.length - r);
            const colspan = Math.min(td.colSpan, colLen - c);
            const r_ab = anchor.row[0] + r;
            const c_ab = anchor.column[0] + c;

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

                    if (rp > 0 || cp > 0) data[r + rp][c + cp] = { mc: { r: r_ab, c: c_ab } };
                }
            }

            if (rowspan > 1 || colspan > 1) cell.mc = { rs: rowspan, cs: colspan, r: r_ab, c: c_ab };
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

// Reads a pasted <style> block into each rule's declarations, keyed by selector. Office wraps the block in an
// HTML comment and writes properties a browser's own CSS parser drops, such as mso-rotate, so the paste reads
// the text itself. A rule for `td.xl65` is filed under `.xl65`. An at-rule such as @page or @media is skipped,
// with the rules nested inside it.
function readStyleRules(css: string): Map<string, Record<string, string>> {
    const rules = new Map<string, Record<string, string>>();
    const text = css
        .replace(/<!--|-->|\/\*[\s\S]*?\*\//g, ' ')
        .replace(/@[^{};]*(?:;|\{(?:[^{}]|\{[^{}]*\})*\})/g, ' ');
    for (const [, selectors, body] of text.matchAll(/([^{}]*)\{([^{}]*)\}/g)) {
        const declarations: Record<string, string> = {};
        for (const [declaration] of body.matchAll(/(?:[^;"']|"[^"]*"|'[^']*')+/g)) {
            const colon = declaration.indexOf(':');
            if (colon > 0) declarations[declaration.slice(0, colon).trim()] = declaration.slice(colon + 1).trim();
        }
        for (const selector of selectors.split(',')) {
            const key = selector.trim().replace(/^td(?=\.)/, '');
            rules.set(key, { ...rules.get(key), ...declarations });
        }
    }
    return rules;
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
    // A plain-text formula lands on one cell.
    const selection = ctx.selections?.[0];
    if (!selection) return;
    const r = selection.row[0];
    const c = selection.column[0];

    const [val] = computeFormula(ctx, formulaStr);

    const d = getFlowdata(ctx);
    if (!d) return;

    const cell = (d[r][c] ??= {});
    cell.m = numberDisplay(val, cell.ct?.fa);
    cell.v = val;
    cell.f = formulaStr;

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
