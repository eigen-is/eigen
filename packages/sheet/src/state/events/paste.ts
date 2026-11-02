// A paste into the grid: cells copied in this tab with their formulas and formats, a cut that moves them,
// an HTML table from another program, plain text or a formula. handlePaste takes a ⌘V on the grid, and
// handlePasteByClick a paste from a menu, such as the context menu. The open cell editor takes its own
// paste, so none of it comes here.

import { bundledFontOfStack, readCssFontSize } from '@workspace/lib/constants/fonts';
import { escapeHtml } from '@workspace/lib/html';
import type { CellBorderSides, ConditionalFormatRule } from '@workspace/lib/sheets';
import { BORDER_SIDE_CSS, SHEET_DEFAULT_FONT_SIZE } from '@workspace/lib/sheets';
import { cloneDeep, forEach, has, includes, isEmpty, isNil, trim } from 'es-toolkit/compat';
import { cfSplitRange, withCfRanges } from '../../engine/conditional-format';
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
import { createContextResolver, setFormulaCellInfo } from '../modules/formula-cache';
import { delFunctionGroup, execFunctionGroup, execfunction } from '../modules/formula-exec';
import { jfrefreshgrid } from '../modules/refresh';
import { COPY_ACTION_TABLE_MARKER, copiedCellText, selectionCache } from '../modules/selection';
import { expandRowsAndColumns, storeSheetSelections } from '../modules/sheet';
import { hasPartMC } from '../modules/validation';
import { getSheetIndex, isAllowEdit } from '../utils';

// One side of a cut and paste: the sheet and the range the cells left or landed on.
type CutPasteSide = { sheetId: string; range: SingleRange };

// After a cut has landed: evaluate the moved formulas where they now live, queue the formulas that read either
// range, and lay the grid out again when the paste grew it. The target is the sheet on screen.
function postPasteCut(ctx: Context, source: CutPasteSide, target: CutPasteSide, grew: boolean) {
    const d = getFlowdata(ctx);
    if (!d) return;

    // trigger linked cell data updates
    const execF_rc: Record<string, number> = {};
    ctx.formulaCache.execFunctionExist = [];
    for (let r = source.range.row[0]; r <= source.range.row[1]; r += 1) {
        for (let c = source.range.column[0]; c <= source.range.column[1]; c += 1) {
            setFormulaCellInfo(ctx, { r, c, id: source.sheetId });
            if (`${r}_${c}_${source.sheetId}` in execF_rc) {
                continue;
            }

            execF_rc[`${r}_${c}_${source.sheetId}`] = 0;
            ctx.formulaCache.execFunctionExist.push({ r, c, id: source.sheetId });
        }
    }

    // A moved formula carries its old value; evaluate it where it now lives.
    const resolver = createContextResolver(ctx);
    for (let r = target.range.row[0]; r <= target.range.row[1]; r += 1) {
        for (let c = target.range.column[0]; c <= target.range.column[1]; c += 1) {
            const cell = d[r]?.[c];
            if (cell?.f != null) {
                [, cell.v] = execfunction(ctx, cell.f, r, c, target.sheetId, undefined, false, false, resolver);
                cell.m = numberDisplay(cell.v, cell.ct?.fa);
            }
            setFormulaCellInfo(ctx, { r, c, id: target.sheetId });
            if (`${r}_${c}_${target.sheetId}` in execF_rc) {
                continue;
            }

            execF_rc[`${r}_${c}_${target.sheetId}`] = 0;
            ctx.formulaCache.execFunctionExist.push({ r, c, id: target.sheetId });
        }
    }

    if (grew) updateContextWithSheetData(ctx, d);

    ctx.selections = [{ row: target.range.row, column: target.range.column }];

    ctx.formulaCache.execFunctionExist.reverse();
    execFunctionGroup(ctx, null, null, null, null, d);
    ctx.formulaCache.execFunctionGlobalData = null;

    storeSheetSelections(ctx);
}

// The HTML paste path's per-cell borders, keyed `${row}_${col}` relative to the pasted block.
function pasteHandler(ctx: Context, data: CellMatrix | string, borderInfo?: Record<string, CellBorderSides>) {
    const allowEdit = isAllowEdit(ctx);
    if (!allowEdit) return;

    if (ctx.selections?.length !== 1) {
        return;
    }

    if (typeof data === 'object') {
        if (data.length === 0) {
            return;
        }

        const copyh = data.length;
        const copyc = data[0].length;

        const minh = ctx.selections[0].row[0]; // first and last row of apply range
        const maxh = minh + copyh - 1;
        const minc = ctx.selections[0].column[0]; // first and last column of apply range
        const maxc = minc + copyc - 1;

        // return with a warning if the apply range contains partially merged cells
        if (hasPartMC(ctx, minh, maxh, minc, maxc)) {
            return;
        }

        const d = getFlowdata(ctx); // fetch data
        if (!d) return;

        // Seeded only once the paste is certain: every config write is syncable now that the
        // mirror is gone, so seeding above the guard would ship an op for a paste that never ran.
        const cfg = (getSheet(ctx).config ??= {});
        cfg.merge ??= {};
        cfg.borderInfo ??= {};

        const rowMaxLength = d.length;
        const cellMaxLength = d[0].length;

        // expand rows/columns if the apply range exceeds the current maximum
        const addr = maxh - rowMaxLength + 1;
        const addc = maxc - cellMaxLength + 1;
        if (addr > 0 || addc > 0) {
            expandRowsAndColumns(ctx, addr, addc);
        }

        if (cfg.rowlen == null) {
            cfg.rowlen = {};
        }

        const offsetMC: Record<string, [number, number]> = {};
        for (let h = minh; h <= maxh; h += 1) {
            const x = d[h];

            let currentRowLen = ctx.defaultrowlen;
            if (cfg.rowlen[h] != null) {
                currentRowLen = cfg.rowlen[h];
            }

            for (let c = minc; c <= maxc; c += 1) {
                const replaced = x?.[c];
                if (replaced?.mc) {
                    if ('rs' in replaced.mc) {
                        delete cfg.merge[`${replaced.mc.r}_${replaced.mc.c}`];
                    }
                    delete replaced.mc;
                }

                let value: Cell | null = null;
                if (data[h - minh] != null && data[h - minh][c - minc] != null) {
                    value = data[h - minh][c - minc];
                }

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

                carrySides(cfg.borderInfo, h, c, borderInfo?.[`${h - minh}_${c - minc}`]);
            }

            if (currentRowLen !== ctx.defaultrowlen) {
                cfg.rowlen[h] = currentRowLen;
            }
        }

        ctx.selections = [{ row: [minh, maxh], column: [minc, maxc] }];

        jfrefreshgrid(ctx, null, undefined);
    } else {
        data = data.replace(/\r/g, '');
        const dataChe = [];
        const che = data.split('\n');
        const colchelen = che[0].split('\t').length;

        for (let i = 0; i < che.length; i += 1) {
            if (che[i].split('\t').length < colchelen) {
                continue;
            }

            dataChe.push(che[i].split('\t'));
        }

        const d = getFlowdata(ctx); // fetch data
        if (!d) return;

        const last = ctx.selections?.[ctx.selections.length - 1];
        if (!last) return;

        const curR = last.row == null ? 0 : last.row[0];
        const curC = last.column == null ? 0 : last.column[0];
        const rlen = dataChe.length;
        const clen = dataChe[0].length;

        // return with a warning if the apply range contains partially merged cells
        let has_PartMC = false;
        if (getSheetConfig(ctx)?.merge != null) {
            has_PartMC = hasPartMC(ctx, curR, curR + rlen - 1, curC, curC + clen - 1);
        }

        if (has_PartMC) {
            return;
        }

        const addr = curR + rlen - d.length;
        const addc = curC + clen - d[0].length;
        if (addr > 0 || addc > 0) {
            expandRowsAndColumns(ctx, addr, addc);
        }

        for (let r = 0; r < rlen; r += 1) {
            const x = d[r + curR];
            for (let c = 0; c < clen; c += 1) {
                const originCell = x[c + curC];
                if (originCell?.f != null) {
                    delete originCell.f;
                    delFunctionGroup(ctx, r + curR, c + curC, ctx.currentSheetId);
                }
                setCellValue(ctx, r + curR, c + curC, d, dataChe[r][c]);
            }
        }

        last.row = [curR, curR + rlen - 1];
        last.column = [curC, curC + clen - 1];

        jfrefreshgrid(ctx, null, undefined);
    }
}

function pasteHandlerOfCutPaste(ctx: Context, copyState: Context['copyState']) {
    if (!isAllowEdit(ctx) || !copyState) return;

    const copySheetId = copyState.dataSheetId;
    const sourceRange = copyState.copyRange[0];

    // A sheet without data has nothing to cut.
    const copySheet = getSheet(ctx, { id: copySheetId });
    if (!copySheet.data) return;
    // A cut moves every cell it took, a row a filter hides too, as Excel does.
    const lines = carriedLines(ctx, copySheetId, [sourceRange], false);

    const copyh = lines.rows.length;
    const copyc = lines.columns.length;

    const last = ctx.selections?.[ctx.selections.length - 1];
    if (!last || last.row_focus == null || last.column_focus == null) return;

    const minh = last.row_focus;
    const maxh = minh + copyh - 1; // first and last row of apply range
    const minc = last.column_focus;
    const maxc = minc + copyc - 1; // first and last column of apply range

    // A cut never lands over part of a merge.
    if (hasPartMC(ctx, minh, maxh, minc, maxc)) {
        return;
    }

    const sheet = getSheet(ctx);
    const d = getFlowdata(ctx);
    if (!d) return;
    const addr = copyh + minh - d.length;
    const addc = copyc + minc - d[0].length;
    const grew = addr > 0 || addc > 0;
    if (grew) expandRowsAndColumns(ctx, addr, addc);

    const tile = { row: minh, column: minc, height: copyh, width: copyc };
    carryCells(ctx, lines, [tile], ({ source }) => source, { cut: true });

    last.row = [minh, maxh];
    last.column = [minc, maxc];

    const targetRange = { row: [minh, maxh], column: [minc, maxc] };
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

    postPasteCut(
        ctx,
        { sheetId: copySheetId, range: sourceRange },
        { sheetId: ctx.currentSheetId, range: targetRange },
        grew,
    );
}

function pasteHandlerOfCopyPaste(ctx: Context, copyState: Context['copyState']) {
    const allowEdit = isAllowEdit(ctx);
    if (!allowEdit) return;

    if (!copyState) return;

    // Live resolver, hoisted: one per paste instead of one snapshot per pasted
    // formula, and each evaluation sees the cells pasted before it.
    const resolver = createContextResolver(ctx);

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

    // warn if the apply range contains partially merged cells
    if (hasPartMC(ctx, minh, maxh, minc, maxc)) {
        return;
    }

    const file = getSheet(ctx);
    const timesH = (maxh - minh + 1) / copyh;
    const timesC = (maxc - minc + 1) / copyc;

    const d = getFlowdata(ctx);
    if (!d) return;

    const rowMaxLength = d.length;
    const cellMaxLength = d[0].length;

    // expand rows/columns if the apply range exceeds the current maximum
    const addr = copyh + minh - rowMaxLength;
    const addc = copyc + minc - cellMaxLength;
    if (addr > 0 || addc > 0) {
        expandRowsAndColumns(ctx, addr, addc);
    }

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
        const funcV = execfunction(ctx, func, r, c, undefined, undefined, true, undefined, resolver);
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

function handleFormulaStringPaste(ctx: Context, formulaStr: string) {
    // plaintext formula is applied only to one cell
    const selection = ctx.selections?.[0];
    if (!selection) return;
    const r = selection.row[0];
    const c = selection.column[0];

    const funcV = execfunction(ctx, formulaStr, r, c, undefined, undefined, true);

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

// A marked table is this tab's own copy while it holds the cells the copy would write now. A copy in another tab, or
// an edit of the copied cells since, is pasted as a table instead. The shape is compared first, so most other tables
// are turned away before a cell's text is read. Only the texts are compared, because building the styles of a large
// copy takes seconds.
function isOwnCopyTable(ctx: Context, html: string, copyState: NonNullable<Context['copyState']>): boolean {
    const index = getSheetIndex(ctx, copyState.dataSheetId);
    const d = index == null ? undefined : ctx.sheets[index].data;
    if (!d) return false;

    // The browser may wrap the copied HTML, but it keeps the cells as written. A tr starts a row.
    const table: string[][] = [];
    for (const [, td] of html.matchAll(/<tr\b|<td\b[^>]*>([\s\S]*?)<\/td>/g)) {
        if (td === undefined) table.push([]);
        else table.at(-1)?.push(td.trim());
    }
    const { rows, columns } = carriedLines(ctx, copyState.dataSheetId, copyState.copyRange, !ctx.pasteIsCut);
    if (table.length !== rows.length) return false;

    // The columns of each row that have a td. A merge writes one td, so the cells it covers have none. A merge whose
    // first row a filter left out has a td for each of its cells.
    const anchors = new Set<string>();
    const written = rows.map((r) => {
        const tdColumns: number[] = [];
        for (const c of columns) {
            const mc = d[r]?.[c]?.mc;
            if (mc?.rs != null) anchors.add(`${r}_${c}`);
            else if (mc && anchors.has(`${mc.r}_${mc.c}`)) continue;
            tdColumns.push(c);
        }
        return tdColumns;
    });
    if (written.some((tdColumns, i) => tdColumns.length !== table[i].length)) return false;

    return rows.every((r, i) => written[i].every((c, j) => table[i][j] === escapeHtml(copiedCellText(d, r, c)).trim()));
}

export function handlePaste(ctx: Context, e: ClipboardEvent) {
    const allowEdit = isAllowEdit(ctx);
    if (!allowEdit) return;

    if (selectionCache.isPasteAction) {
        ctx.editingCellPosition = [];
        selectionCache.isPasteAction = false;

        const { clipboardData } = e;
        if (!clipboardData) return;

        let txtdata = clipboardData.getData('text/html') || clipboardData.getData('text/plain');

        const { copyState } = ctx;
        if (
            txtdata.indexOf(COPY_ACTION_TABLE_MARKER) > -1 &&
            copyState != null &&
            copyState.copyRange.length > 0 &&
            isOwnCopyTable(ctx, txtdata, copyState)
        ) {
            if (ctx.pasteIsCut) {
                ctx.pasteIsCut = false;
                pasteHandlerOfCutPaste(ctx, copyState);
                ctx.formulaRangeSelections = [];
            } else {
                pasteHandlerOfCopyPaste(ctx, copyState);
            }
        } else {
            if (txtdata.indexOf('table') > -1) {
                // Parse into an inert document, never a live <div>: txtdata is OS clipboard HTML and
                // a live element's innerHTML loads <img> and fires its onerror even while detached.
                const parsed = new DOMParser().parseFromString(txtdata, 'text/html');

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

                const index = getSheetIndex(ctx, ctx.currentSheetId);
                const anchor = ctx.selections?.[0];
                if (!isNil(index) && anchor) {
                    // Collect only the rows the paste changes and let setRowHeight write them: it
                    // owns the `>= 0` guard, and writing through the sheet's live rowlen bypassed it.
                    const currentRowlen = ctx.sheets[index].config?.rowlen ?? {};
                    const rowHeightList: Record<number, number> = {};
                    forEach(trList, (tr) => {
                        let c = 0;
                        const targetR = anchor.row[0] + r;

                        const heightAttr = tr.getAttribute('height');
                        if (!isNil(heightAttr)) {
                            const targetRowHeight = parseInt(heightAttr, 10);
                            const current = has(currentRowlen, targetR) ? currentRowlen[targetR] : ctx.defaultrowlen;
                            if (current !== targetRowHeight) {
                                rowHeightList[targetR] = targetRowHeight;
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
                                includes(td.style.textDecoration, 'underline') ||
                                includes(styles['text-decoration'], 'underline')
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
                                            const shorthand = onEdge[side]
                                                ? td.style.getPropertyValue(`border-${css}`)
                                                : '';
                                            if (isEmpty(shorthand) || shorthand.slice(0, 3).toLowerCase() === '0px')
                                                continue;
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
                            if (c === colLen) {
                                return true;
                            }
                            return true;
                        });

                        r += 1;
                    });
                    setRowHeight(ctx, rowHeightList);
                }

                ctx.formulaRangeSelections = [];
                pasteHandler(ctx, data, borderInfo);
            }
            // the copied content is an image file — hand it to the app's fit-to-pane insert + upload
            // (the Insert-menu / OS-drop path); the engine carries no upload seam of its own (U5c).
            else if (clipboardData.files.length === 1 && clipboardData.files[0].type.indexOf('image') > -1) {
                ctx.hooks.onPasteImageFile?.(clipboardData.files[0]);
            } else {
                txtdata = clipboardData.getData('text/plain');
                const isExcelFormula = txtdata.startsWith('=');

                if (isExcelFormula) {
                    handleFormulaStringPaste(ctx, txtdata);
                } else {
                    pasteHandler(ctx, txtdata);
                }
            }
        }
    }
}

export function handlePasteByClick(ctx: Context, clipboardData: string, triggerType?: string) {
    const allowEdit = isAllowEdit(ctx);
    if (!allowEdit) return;

    // If we have an internal copy/cut save, use that
    if (ctx.copyState?.copyRange != null && ctx.copyState.copyRange.length > 0) {
        if (ctx.pasteIsCut) {
            ctx.pasteIsCut = false;
            pasteHandlerOfCutPaste(ctx, ctx.copyState);
        } else {
            pasteHandlerOfCopyPaste(ctx, ctx.copyState);
        }
    } else if (clipboardData && triggerType !== 'btn') {
        const isExcelFormula = clipboardData.startsWith('=');
        if (isExcelFormula) {
            handleFormulaStringPaste(ctx, clipboardData);
        } else {
            pasteHandler(ctx, clipboardData);
        }
    }
}
