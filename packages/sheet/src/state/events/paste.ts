// A paste into the grid: cells copied in this tab with their formulas and formats, a cut that moves them, an HTML table
// from another program, plain text or a formula. The Workbook hands handlePaste the clipboard of a paste event, and a
// menu row reads the clipboard through pasteFromClipboard to do the same. The open cell editor takes its own paste, so
// none of it comes here. Each kind asks roomFor before its first write, which refuses it or grows the grid.

import { formatForDisplay } from '@tanstack/react-hotkeys';
import { bundledFontOfStack, readCssFontSize } from '@workspace/lib/constants/fonts';
import type { CellBorderSides, ConditionalFormatRule } from '@workspace/lib/sheets';
import { BORDER_SIDE_CSS, SHEET_DEFAULT_FONT_SIZE } from '@workspace/lib/sheets';
import { cloneDeep, forEach, includes, isEmpty, isNil, times, trim } from 'es-toolkit/compat';
import { createArrayResolver } from '../../engine/cell-resolver';
import { cfSplitRange, withCfRanges } from '../../engine/conditional-format';
import { MAX_SHEET_COLUMN_COUNT, MAX_SHEET_ROW_COUNT } from '../../engine/defaults';
import { numberDisplay, parseCellInput } from '../../engine/format';
import { functionCopy } from '../../engine/formula-shift';
import type { Cell, CellMatrix, SingleRange } from '../../engine/types';
import { setRowHeight } from '../api';
import { getSheet } from '../api/common';
import type { Context } from '../context';
import { getFlowdata, getSheetConfig, updateContextWithSheetData } from '../context';
import { carrySides } from '../modules/border';
import type { CarryTile } from '../modules/cell';
import { carriedLines, carryCells, getQKBorder, landedRanges, setCellValue } from '../modules/cell';
import { setFormulaCellInfo } from '../modules/formula-cache';
import { delFunctionGroup, execFunctionGroup, execfunction } from '../modules/formula-exec';
import { jfrefreshgrid } from '../modules/refresh';
import { hasPartMC } from '../modules/validation';
import type { Selection } from '../types';
import { getSheetIndex } from '../utils';
import { SHEET_HOTKEYS } from './keyboard';

// What a paste reads of the clipboard: a paste event's DataTransfer, or one a menu row filled.
type PastedData = { getData: (type: string) => string; files: ArrayLike<File> };

// The one paste of the grid, from a paste event or a menu row. A paste is the workbook's own copy exactly when the
// clipboard's table carries its id, and then it lands the live cells with their formulas and formats. A copy whose sheet
// is gone pastes as a table.
export function handlePaste(ctx: Context, clipboardData: PastedData) {
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
        // The app's fit-to-pane insert and upload, as the Insert menu and an OS drop run it.
        ctx.hooks.onPasteImageFile?.(clipboardData.files[0]);
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

    // A sheet without data has nothing to cut.
    const copySheet = getSheet(ctx, { id: copySheetId });
    if (!copySheet.data) return;
    // A cut moves every cell it took, a row a filter hides too, as Excel does.
    const lines = carriedLines(ctx, copySheetId, [sourceRange], false);

    const height = lines.rows.length;
    const width = lines.columns.length;

    const last = ctx.selections?.[ctx.selections.length - 1];
    if (!last || last.row_focus == null || last.column_focus == null) return;

    const top = last.row_focus;
    const bottom = top + height - 1;
    const left = last.column_focus;
    const right = left + width - 1;

    const sheet = getSheet(ctx);
    const rowsBefore = sheet.data?.length ?? 0;
    const columnsBefore = sheet.data?.[0]?.length ?? 0;
    const d = roomFor(ctx, top, bottom, left, right);
    if (!d) return;

    const tile = { row: top, column: left, height, width };
    carryCells(ctx, lines, [tile], ({ source }) => source, { cut: true });

    last.row = [top, bottom];
    last.column = [left, right];

    const targetRange = { row: [top, bottom], column: [left, right] };
    if (ctx.currentSheetId !== copySheetId) {
        // A rule over cut cells splits: the part over them moves to the target, the rest stays.
        const sourceRules = cloneDeep(copySheet.conditionalFormatRules) ?? [];
        const movedRules: ConditionalFormatRule[] = [];
        for (let i = 0; i < sourceRules.length; i += 1) {
            const rule = sourceRules[i];
            const moved = rule.cellrange.flatMap((range) =>
                cfSplitRange(range, sourceRange, targetRange, 'operatePart'),
            );
            if (moved.length > 0) movedRules.push(cloneDeep(withCfRanges(rule, moved)));
            const rest = rule.cellrange.flatMap((range) => cfSplitRange(range, sourceRange, targetRange, 'restPart'));
            sourceRules[i] = withCfRanges(rule, rest);
        }
        if (movedRules.length > 0) {
            // A rule whose every cell was cut away has moved to the target.
            copySheet.conditionalFormatRules = sourceRules.filter((rule) => rule.cellrange.length > 0);
            sheet.conditionalFormatRules = [...(cloneDeep(sheet.conditionalFormatRules) ?? []), ...movedRules];
        }
    } else if (sheet.conditionalFormatRules) {
        sheet.conditionalFormatRules = sheet.conditionalFormatRules.map((rule) =>
            withCfRanges(
                cloneDeep(rule),
                rule.cellrange.flatMap((range) => cfSplitRange(range, sourceRange, targetRange, 'allPart')),
            ),
        );
    }

    // The formulas that read either range recompute, each queued once. A moved formula carries its old value, so it is
    // evaluated where it now lives.
    const resolver = createArrayResolver(ctx.sheets);
    const queued = new Map<string, { r: number; c: number; id: string }>();
    const queue = (id: string, { row, column }: SingleRange, evaluate: boolean) => {
        for (let r = row[0]; r <= row[1]; r += 1) {
            for (let c = column[0]; c <= column[1]; c += 1) {
                const cell = evaluate ? d[r]?.[c] : undefined;
                if (cell?.f != null) {
                    [, cell.v] = execfunction(ctx, cell.f, r, c, { id, resolver });
                    cell.m = numberDisplay(cell.v, cell.ct?.fa);
                }
                setFormulaCellInfo(ctx, { r, c, id });
                if (!queued.has(`${r}_${c}_${id}`)) queued.set(`${r}_${c}_${id}`, { r, c, id });
            }
        }
    };
    queue(copySheetId, sourceRange, false);
    queue(ctx.currentSheetId, targetRange, true);

    if (d.length > rowsBefore || d[0].length > columnsBefore) updateContextWithSheetData(ctx, d);
    ctx.selections = [{ row: targetRange.row, column: targetRange.column }];
    ctx.formulaCache.execFunctionExist = [...queued.values()].reverse();
    execFunctionGroup(ctx, null, null, null, null, d);
    ctx.formulaCache.execFunctionGlobalData = null;
    // A cut moves its cells once. The clipboard still holds them, and a next paste lands them as a table.
    ctx.copyState = undefined;
    ctx.formulaRangeSelections = [];
}

function pasteCopy(ctx: Context, copyState: NonNullable<Context['copyState']>) {
    // One live resolver per paste, so each evaluation sees the cells pasted before it.
    const resolver = createArrayResolver(ctx.sheets);

    const copySheetId = copyState.dataSheetId;
    const lines = carriedLines(ctx, copySheetId, copyState.copyRange, true);
    const copyh = lines.rows.length;
    const copyc = lines.columns.length;
    // A filter can hide every row of the copy.
    if (copyh === 0 || copyc === 0) return;

    const last = ctx.selections?.[ctx.selections.length - 1];
    if (!last) return;
    const minh = last.row[0];
    let maxh = last.row[1]; // first and last row of apply range
    const minc = last.column[0];
    let maxc = last.column[1]; // first and last column of apply range

    const mh = (maxh - minh + 1) % copyh;
    const mc = (maxc - minc + 1) % copyc;

    if (mh !== 0 || mc !== 0) {
        // if the apply range is not an integer multiple of the copy data dimensions, use the copy data dimensions
        maxh = minh + copyh - 1;
        maxc = minc + copyc - 1;
    }

    const d = roomFor(ctx, minh, maxh, minc, maxc);
    if (!d) return;

    const file = getSheet(ctx);
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
    carryCells(ctx, lines, tiles, ({ source: cell, r, c, sr, sc }) => {
        if (cell?.f == null) return cell;
        if (several) {
            delete cell.f;
            return cell;
        }
        const func = r === sr && c === sc ? cell.f : `=${functionCopy(cell.f, r - sr, c - sc)}`;
        const funcV = execfunction(ctx, func, r, c, { isrefresh: true, resolver });
        [, cell.v, cell.f] = funcV;
        cell.m = numberDisplay(funcV[1], cell.ct?.fa);
        return cell;
    });

    // A rule over copied cells also covers where they landed.
    const pastedRules: ConditionalFormatRule[] = [];
    for (const rule of getSheet(ctx, { id: copySheetId }).conditionalFormatRules ?? []) {
        const cellrange = tiles.flatMap((tile) => rule.cellrange.flatMap((range) => landedRanges(range, lines, tile)));
        if (cellrange.length > 0) pastedRules.push(withCfRanges(cloneDeep(rule), cellrange));
    }
    if (pastedRules.length > 0) {
        file.conditionalFormatRules = [...(cloneDeep(file.conditionalFormatRules) ?? []), ...pastedRules];
    }

    last.row = [minh, maxh];
    last.column = [minc, maxc];

    jfrefreshgrid(ctx, d, ctx.selections);
}

// An HTML table from another program, or from a copy of another tab, with the cells' styles as the HTML carries them.
function pasteTable(ctx: Context, html: string) {
    const anchor = ctx.selections?.[0];
    if (!anchor) return;

    // Parse into an inert document, never a live <div>: a live element's innerHTML loads <img> and fires its onerror even
    // while detached.
    const parsed = new DOMParser().parseFromString(html, 'text/html');

    const trList = parsed.querySelectorAll('table tr');
    if (trList.length === 0) {
        return;
    }

    const data = new Array(trList.length);
    let colLen = 0;
    forEach(trList[0].querySelectorAll('td'), (td) => {
        let colspan = td.colSpan;
        if (Number.isNaN(colspan)) {
            colspan = 1;
        }
        colLen += colspan;
    });

    for (let i = 0; i < data.length; i += 1) {
        data[i] = new Array(colLen);
    }

    let r = 0;
    const borderInfo: Record<string, CellBorderSides> = {};
    const styleRules = readStyleRules(parsed.querySelector('style')?.textContent ?? '');
    const tdVerticalAlign = styleRules.get('td')?.['vertical-align'];

    const currentRowlen = getSheetConfig(ctx)?.rowlen ?? {};
    const rowHeights: Record<number, number> = {};
    forEach(trList, (tr) => {
        let c = 0;
        const targetR = anchor.row[0] + r;

        const heightAttr = tr.getAttribute('height');
        if (!isNil(heightAttr)) {
            const targetRowHeight = parseInt(heightAttr, 10);
            if ((currentRowlen[targetR] ?? ctx.defaultrowlen) !== targetRowHeight) {
                rowHeights[targetR] = targetRowHeight;
            }
        }

        forEach(tr.querySelectorAll('td'), (td) => {
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
            if (bg === 'rgba(0, 0, 0, 0)' || isEmpty(bg)) {
                bg = undefined;
            }

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

            const ht = td.style.textAlign || styles['text-align'] || 'left';
            if (ht === 'center') {
                cell.ht = 0;
            } else if (ht === 'right') {
                cell.ht = 2;
            } else {
                cell.ht = 1;
            }

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

            if (c === colLen) {
                return true;
            }

            if (isNil(data[r][c])) {
                data[r][c] = cell;
                let rowspan = parseInt(td.getAttribute('rowspan') ?? '1', 10);
                let colspan = parseInt(td.getAttribute('colspan') ?? '1', 10);

                if (Number.isNaN(rowspan)) {
                    rowspan = 1;
                }

                if (Number.isNaN(colspan)) {
                    colspan = 1;
                }

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

                        if (rp === 0 && cp === 0) {
                            continue;
                        }

                        data[r + rp][c + cp] = { mc: { r: r_ab, c: c_ab } };
                    }
                }

                if (rowspan > 1 || colspan > 1) {
                    const first = { rs: rowspan, cs: colspan, r: r_ab, c: c_ab };
                    data[r][c].mc = first;
                }
            }
            c += 1;
            return true;
        });

        r += 1;
    });
    ctx.formulaRangeSelections = [];
    landTable(ctx, anchor, data, borderInfo, rowHeights);
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

// Lands a parsed table at its anchor. borderInfo's keys are `${row}_${col}` within the table.
function landTable(
    ctx: Context,
    anchor: Selection,
    data: CellMatrix,
    borderInfo: Record<string, CellBorderSides>,
    rowHeights: Record<number, number>,
) {
    const minh = anchor.row[0];
    const maxh = minh + data.length - 1;
    const minc = anchor.column[0];
    const maxc = minc + data[0].length - 1;

    const d = roomFor(ctx, minh, maxh, minc, maxc);
    if (!d) return;

    setRowHeight(ctx, rowHeights);
    const cfg = (getSheet(ctx).config ??= {});
    cfg.merge ??= {};
    cfg.borderInfo ??= {};

    const offsetMC: Record<string, [number, number]> = {};
    for (let h = minh; h <= maxh; h += 1) {
        const x = d[h];

        for (let c = minc; c <= maxc; c += 1) {
            const replaced = x[c];
            if (replaced?.mc) {
                if ('rs' in replaced.mc) {
                    delete cfg.merge[`${replaced.mc.r}_${replaced.mc.c}`];
                }
                delete replaced.mc;
            }

            const value = data[h - minh]?.[c - minc] ?? null;
            x[c] = value;

            const cellMc = x[c]?.mc;
            if (value != null && cellMc) {
                const valueMc = value.mc;
                if (cellMc.rs != null && valueMc != null) {
                    cellMc.r = h;
                    cellMc.c = c;

                    cfg.merge[`${cellMc.r}_${cellMc.c}`] = {
                        r: cellMc.r,
                        c: cellMc.c,
                        rs: cellMc.rs,
                        cs: cellMc.cs ?? 1,
                    };

                    offsetMC[`${valueMc.r}_${valueMc.c}`] = [cellMc.r, cellMc.c];
                } else if (valueMc != null) {
                    x[c] = {
                        mc: {
                            r: offsetMC[`${valueMc.r}_${valueMc.c}`][0],
                            c: offsetMC[`${valueMc.r}_${valueMc.c}`][1],
                        },
                    };
                }
            }

            carrySides(cfg.borderInfo, h, c, borderInfo[`${h - minh}_${c - minc}`]);
        }
    }

    ctx.selections = [{ row: [minh, maxh], column: [minc, maxc] }];

    jfrefreshgrid(ctx, null, undefined);
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

    for (const [r, row] of rows.entries()) {
        for (let c = 0; c < columns; c += 1) {
            const originCell = d[r + top][c + left];
            if (originCell?.f != null) {
                delete originCell.f;
                delFunctionGroup(ctx, r + top, c + left, ctx.currentSheetId);
            }
            setCellValue(ctx, r + top, c + left, d, row[c]);
        }
    }

    selection.row = [top, bottom];
    selection.column = [left, right];

    jfrefreshgrid(ctx, null, undefined);
}

function pasteFormula(ctx: Context, formulaStr: string) {
    // A plain-text formula lands on one cell.
    const selection = ctx.selections?.[0];
    if (!selection) return;
    const r = selection.row[0];
    const c = selection.column[0];

    const funcV = execfunction(ctx, formulaStr, r, c, { isrefresh: true });

    const val = funcV[1];

    const d = getFlowdata(ctx);
    if (!d) return;

    const cell = (d[r][c] ??= {});
    cell.m = numberDisplay(val, cell.ct?.fa);
    cell.v = val;
    cell.f = formulaStr;

    setFormulaCellInfo(ctx, { r, c, id: ctx.currentSheetId });
    ctx.formulaCache.execFunctionGlobalData = null;
}

// The grid a paste lands in, grown when the paste runs past its last row or column. Every paste asks here before it
// writes, so a refused one ships no op and takes no undo step. Nothing comes back when the paste would land over part
// of a merge, or would grow the sheet past its limits, which the notice says. The sheet's size grows with the grid,
// because a stored snapshot keeps the size and a reader builds the grid at that size.
function roomFor(ctx: Context, top: number, bottom: number, left: number, right: number): CellMatrix | undefined {
    if (hasPartMC(ctx, top, bottom, left, right)) return undefined;
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
    // A whole column or row in the formula map still ends where the grid ended, as after a row insert.
    ctx.formulaCache.formulaCellInfoMap = null;
    return data;
}
