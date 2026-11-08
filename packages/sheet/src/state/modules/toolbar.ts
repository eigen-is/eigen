// The actions of the format toolbar and the Format menu on the selection, such as bold, the font, a
// number format, borders, merging and autosum. Each runs inside a setContext recipe. While a cell is
// open on text, a font format goes to the editor's selected characters rather than to the cells.

import type { BorderType } from '@workspace/lib/sheets';
import { forEach, isNil, isPlainObject, pick, round } from 'es-toolkit/compat';
import { cellValue, is_date, numberDisplay } from '../../engine/format';
import type { Cell, CellMatrix } from '../../engine/types';
import type { Context } from '../context';
import { getFlowdata, getSheetConfig } from '../context';
import { clipToUsedExtent, getSheetIndex } from '../utils';
import { applyBorder, clearSides } from './border';
import { getRangetxt, isAllSelectedCellsInStatus, setCellValue } from './cell';
import { openCellEditor } from './cell-editor';
import { rangeColor } from './color';
import { israngeseleciton } from './formula-editor';
import { computeFormula } from './formula-exec';
import { createFormulaRangeSelect, rangeSetValue } from './formula-range';
import { showLinkCard } from './hyperlink';
import {
    editorSelectionStyle,
    formatEditorSelection,
    isRunStyleKey,
    updateInlineStringFormatOutside,
} from './inline-string';
import { colLocationByIndex, rowLocationByIndex } from './location';
import { mergeCells } from './merge';
import { recomputeCells } from './refresh';
import { selectIsOverlap } from './selection';

import { getCellTextInfo, measuringContext } from './text';
import { hasPartMC, isRealNull, isRealNum } from './validation';

export function updateFormatCell(
    ctx: Context,
    d: CellMatrix,
    attr: keyof Cell,
    foucsStatus: string | number,
    row_st: number,
    row_ed: number,
    col_st: number,
    col_ed: number,
) {
    if (isNil(d) || isNil(attr)) {
        return;
    }
    const sheetIndex = getSheetIndex(ctx, ctx.currentSheetId);
    if (sheetIndex == null) {
        return;
    }
    const cfg = (ctx.sheets[sheetIndex].config ??= {});
    if (attr === 'ct') {
        for (let r = row_st; r <= row_ed; r += 1) {
            if (!isNil(cfg.rowhidden) && !isNil(cfg.rowhidden[r])) {
                continue;
            }

            for (let c = col_st; c <= col_ed; c += 1) {
                const cell = d[r][c];
                let value = cell?.v;

                if (foucsStatus !== '@' && isRealNum(value)) {
                    value = Number(value);
                }

                const mask = numberDisplay(value, String(foucsStatus));
                let type = 'n';

                if (
                    is_date(foucsStatus) ||
                    foucsStatus === 14 ||
                    foucsStatus === 15 ||
                    foucsStatus === 16 ||
                    foucsStatus === 17 ||
                    foucsStatus === 18 ||
                    foucsStatus === 19 ||
                    foucsStatus === 20 ||
                    foucsStatus === 21 ||
                    foucsStatus === 22 ||
                    foucsStatus === 45 ||
                    foucsStatus === 46 ||
                    foucsStatus === 47
                ) {
                    type = 'd';
                } else if (foucsStatus === '@' || foucsStatus === 49) {
                    type = 's';
                } else if (foucsStatus === 'General' || foucsStatus === 0) {
                    type = isRealNum(value) ? 'n' : 'g';
                }

                if (cell && isPlainObject(cell)) {
                    cell.m = `${mask}`;
                    if (isNil(cell.ct)) {
                        cell.ct = {};
                    }
                    cell.ct.fa = String(foucsStatus);
                    cell.ct.t = type;
                } else {
                    d[r][c] = {
                        ct: { fa: String(foucsStatus), t: type },
                        v: value as string,
                        m: mask,
                    };
                }
            }
        }
    } else {
        if (attr === 'ht') {
            if (foucsStatus === 'left') {
                foucsStatus = '1';
            } else if (foucsStatus === 'center') {
                foucsStatus = '0';
            } else if (foucsStatus === 'right') {
                foucsStatus = '2';
            }
        } else if (attr === 'vt') {
            if (foucsStatus === 'top') {
                foucsStatus = '1';
            } else if (foucsStatus === 'middle') {
                foucsStatus = '0';
            } else if (foucsStatus === 'bottom') {
                foucsStatus = '2';
            }
        } else if (attr === 'tb') {
            if (foucsStatus === 'overflow') {
                foucsStatus = '1';
            } else if (foucsStatus === 'clip') {
                foucsStatus = '0';
            } else if (foucsStatus === 'wrap') {
                foucsStatus = '2';
            }
        }

        for (let r = row_st; r <= row_ed; r += 1) {
            if (!isNil(cfg.rowhidden) && !isNil(cfg.rowhidden[r])) {
                continue;
            }

            for (let c = col_st; c <= col_ed; c += 1) {
                const value = d[r][c];

                if (value && isPlainObject(value)) {
                    if (isRunStyleKey(attr)) updateInlineStringFormatOutside(value, attr, foucsStatus);
                    Object.assign(value, { [attr]: foucsStatus });
                    const cellWidth = cfg.columnlen?.[c] || ctx.defaultcollen;
                    // A larger size or wrapped lines need a taller row. The row grows to fit and never
                    // shrinks here, as another cell in it may need the height.
                    const measuring =
                        attr === 'fs' || (attr === 'tb' && foucsStatus === '2') ? measuringContext() : null;
                    if (measuring) {
                        const textInfo = getCellTextInfo(value, measuring, { r, c, cellWidth });
                        if (textInfo?.textHeightAll == null) continue;
                        const rowHeight = round(textInfo.textHeightAll);
                        const currentRowHeight = cfg.rowlen?.[r] || ctx.defaultrowlen;
                        if (rowHeight > currentRowHeight && cfg.customHeight?.[r] !== 1) {
                            (cfg.rowlen ??= {})[r] = rowHeight;
                        }
                    }
                } else {
                    d[r][c] = { [attr]: foucsStatus };
                }
            }
        }
    }
}

export function updateFormat(
    ctx: Context,
    $input: HTMLDivElement,
    d: CellMatrix,
    attr: keyof Cell,
    foucsStatus: string | number,
) {
    if (ctx.allowEdit === false) return;

    if (isRunStyleKey(attr) && isEditingText(ctx, $input)) {
        const [r, c] = ctx.editingCellPosition;
        formatEditorSelection($input, d[r]?.[c], attr, foucsStatus);
        return;
    }

    forEach(ctx.selections, (selection) => {
        const [row_st, row_ed] = selection.row;
        const [col_st, col_ed] = selection.column;

        updateFormatCell(ctx, d, attr, foucsStatus, row_st, row_ed, col_st, col_ed);
    });
}

// While a cell is open on text, not a formula, a font format applies to the editor's selected
// characters, and to a new cell as well as a filled one.
function isEditingText(ctx: Context, $input: HTMLDivElement) {
    return ctx.editingCellPosition.length > 0 && !$input.innerText.startsWith('=');
}

function toggleAttr(ctx: Context, cellInput: HTMLDivElement, attr: 'bl' | 'it' | 'un' | 'cl') {
    const flowdata = getFlowdata(ctx);
    if (!flowdata) return;

    const [r, c] = ctx.editingCellPosition;
    const isOn = isEditingText(ctx, cellInput)
        ? Boolean(editorSelectionStyle(cellInput, flowdata[r]?.[c])?.[attr])
        : isAllSelectedCellsInStatus(ctx, attr, 1);

    updateFormat(ctx, cellInput, flowdata, attr, isOn ? 0 : 1);
}

function setAttr(ctx: Context, cellInput: HTMLDivElement, attr: keyof Cell, value: string | number) {
    const flowdata = getFlowdata(ctx);
    if (!flowdata) return;

    updateFormat(ctx, cellInput, flowdata, attr, value);
}

function checkNoNullValue(cell: Cell | null) {
    return isRealNum(cellValue(cell)) && (cell?.ct?.t == null || cell.ct.t === 'n' || cell.ct.t === 'g');
}

function checkNoNullValueAll(cell: Cell | null) {
    return !isRealNull(cellValue(cell));
}

// A cell autosum must not write over: one holding a value or text.
function holdsValue(cell: Cell | null) {
    const v = cellValue(cell);
    return v != null && v.toString().length > 0;
}

function getNoNullValue(d: CellMatrix, st_x: number, ed: number, type: string) {
    let hasValueStart = null;
    let nullNum = 0;
    let nullTime = 0;

    for (let r = ed - 1; r >= 0; r -= 1) {
        let cell: Cell | null;
        if (type === 'c') {
            cell = d[st_x][r];
        } else {
            cell = d[r][st_x];
        }

        if (checkNoNullValue(cell)) {
            hasValueStart = r;
        } else if (!holdsValue(cell)) {
            nullNum += 1;

            if (nullNum >= 40) {
                if (nullTime <= 0) {
                    nullTime = 1;
                } else {
                    break;
                }
            }
        } else {
            break;
        }
    }

    return hasValueStart;
}

function activeFormulaInput(
    cellInput: HTMLDivElement,
    fxInput: HTMLDivElement | null | undefined,
    ctx: Context,
    row_index: number,
    col_index: number,
    rowh: number[] | null,
    columnh: number[] | null,
    formula: string,
    isnull = false,
) {
    if (isnull) {
        const html = `<span dir="auto" class="sheet-formula-text-color">=</span><span dir="auto" class="sheet-formula-text-color">${formula.toUpperCase()}</span><span dir="auto" class="sheet-formula-text-color">(</span><span dir="auto" class="sheet-formula-text-color">)</span>`;
        openCellEditor(ctx, row_index, col_index, { html, caret: formula.length + 2 });
        return;
    }

    if (rowh == null || columnh == null) return;
    const row_pre = rowLocationByIndex(rowh[0], ctx.visibledatarow)[0];
    const row = rowLocationByIndex(rowh[1], ctx.visibledatarow)[1];
    const col_pre = colLocationByIndex(columnh[0], ctx.visibledatacolumn)[0];
    const col = colLocationByIndex(columnh[1], ctx.visibledatacolumn)[1];

    const html = `<span dir="auto" class="sheet-formula-text-color">=</span><span dir="auto" class="sheet-formula-text-color">${formula.toUpperCase()}</span><span dir="auto" class="sheet-formula-text-color">(</span><span class="sheet-formula-functionrange-cell" rangeindex="0" dir="auto" style="color:${rangeColor(
        0,
    )};">${getRangetxt(
        ctx,
        ctx.currentSheetId,
        { row: rowh, column: columnh },
        ctx.currentSheetId,
    )}</span><span dir="auto" class="sheet-formula-text-color">)</span>`;
    openCellEditor(ctx, row_index, col_index, { html });

    israngeseleciton(ctx);
    ctx.formulaCache.rangestart = true;
    ctx.formulaCache.rangedrag_column_start = false;
    ctx.formulaCache.rangedrag_row_start = false;
    ctx.formulaCache.rangechangeindex = 0;
    rangeSetValue(ctx, cellInput, { row: rowh, column: columnh }, fxInput);
    ctx.formulaCache.func_selectedrange = {
        left: col_pre,
        width: col - col_pre - 1,
        top: row_pre,
        height: row - row_pre - 1,
        left_move: col_pre,
        width_move: col - col_pre - 1,
        top_move: row_pre,
        height_move: row - row_pre - 1,
        row: [row_index, row_index],
        column: [col_index, col_index],
    };

    createFormulaRangeSelect(ctx, {
        rangeIndex: ctx.formulaCache.rangeIndex || 0,
        left: col_pre,
        width: col - col_pre - 1,
        top: row_pre,
        height: row - row_pre - 1,
    });
}

function backFormulaInput(
    d: CellMatrix,
    r: number,
    c: number,
    rowh: number[],
    columnh: number[],
    formula: string,
    ctx: Context,
) {
    const f = `=${formula.toUpperCase()}(${getRangetxt(
        ctx,
        ctx.currentSheetId,
        { row: rowh, column: columnh },
        ctx.currentSheetId,
    )})`;
    const [v, formulaText] = computeFormula(ctx, f);
    setCellValue(ctx, r, c, d, { v, f: formulaText });
    recomputeCells(ctx, [{ r, c, id: ctx.currentSheetId }], d);
}

function singleFormulaInput(
    cellInput: HTMLDivElement,
    fxInput: HTMLDivElement | null | undefined,
    ctx: Context,
    d: CellMatrix,
    _index: number,
    fix: number,
    st_m: number,
    ed_m: number,
    formula: string,
    type: string,
    noNum = true,
    noNull = true,
) {
    let isNull = true;
    let isNum = false;

    for (let c = st_m; c <= ed_m; c += 1) {
        let cell = null;

        if (type === 'c') {
            cell = d[c][fix];
        } else {
            cell = d[fix][c];
        }

        if (checkNoNullValue(cell)) {
            isNull = false;
            isNum = true;
        } else if (checkNoNullValueAll(cell)) {
            isNull = false;
        }
    }

    if (isNull && noNull) {
        let st_r_r = getNoNullValue(d, _index, fix, type);

        if (st_r_r == null) {
            if (type === 'c') {
                activeFormulaInput(cellInput, fxInput, ctx, _index, fix, null, null, formula, true);
            } else {
                activeFormulaInput(cellInput, fxInput, ctx, fix, _index, null, null, formula, true);
            }
        } else {
            if (_index === st_m) {
                for (let c = st_m; c <= ed_m; c += 1) {
                    st_r_r = getNoNullValue(d, c, fix, type);

                    if (st_r_r == null) {
                        break;
                    }

                    if (type === 'c') {
                        backFormulaInput(d, c, fix, [c, c], [st_r_r, fix - 1], formula, ctx);
                    } else {
                        backFormulaInput(d, fix, c, [st_r_r, fix - 1], [c, c], formula, ctx);
                    }
                }
            } else {
                for (let c = ed_m; c >= st_m; c -= 1) {
                    st_r_r = getNoNullValue(d, c, fix, type);

                    if (st_r_r == null) {
                        break;
                    }

                    if (type === 'c') {
                        backFormulaInput(d, c, fix, [c, c], [st_r_r, fix - 1], formula, ctx);
                    } else {
                        backFormulaInput(d, fix, c, [st_r_r, fix - 1], [c, c], formula, ctx);
                    }
                }
            }
        }
        return;
    }
    if (isNum && noNum) {
        let cell = null;

        if (type === 'c') {
            cell = d[ed_m + 1][fix];
        } else {
            cell = d[fix][ed_m + 1];
        }

        /* Note: exclude the cell itself during search to prevent a cell formula from referencing itself */
        if (holdsValue(cell)) {
            let c = ed_m + 1;

            if (type === 'c') {
                cell = d[ed_m + 1][fix];
            } else {
                cell = d[fix][ed_m + 1];
            }

            while (holdsValue(cell)) {
                c += 1;
                let len = null;

                if (type === 'c') {
                    len = d.length;
                } else {
                    len = d[0].length;
                }

                if (c >= len) return;

                if (type === 'c') {
                    cell = d[c][fix];
                } else {
                    cell = d[fix][c];
                }
            }

            if (type === 'c') {
                backFormulaInput(d, c, fix, [st_m, ed_m], [fix, fix], formula, ctx);
            } else {
                backFormulaInput(d, fix, c, [fix, fix], [st_m, ed_m], formula, ctx);
            }
        } else {
            if (type === 'c') {
                backFormulaInput(d, ed_m + 1, fix, [st_m, ed_m], [fix, fix], formula, ctx);
            } else {
                backFormulaInput(d, fix, ed_m + 1, [fix, fix], [st_m, ed_m], formula, ctx);
            }
        }
    }
}

export function autoSelectionFormula(
    ctx: Context,
    cellInput: HTMLDivElement,
    fxInput: HTMLDivElement | null | undefined,
    formula: string,
) {
    if (ctx.allowEdit === false) return;
    const flowdata = getFlowdata(ctx);
    if (flowdata == null) return;

    function execFormulaInput_c(
        d: CellMatrix,
        st_r: number,
        ed_r: number,
        st_c: number,
        ed_c: number,
        _formula: string,
    ) {
        const st_c_c = getNoNullValue(d, st_r, ed_c, 'c');

        if (st_c_c == null) {
            activeFormulaInput(cellInput, fxInput, ctx, st_r, st_c, null, null, _formula, true);
        } else {
            activeFormulaInput(cellInput, fxInput, ctx, st_r, st_c, [st_r, ed_r], [st_c_c, ed_c - 1], _formula);
        }
    }

    function execFormulaInput(d: CellMatrix, st_r: number, ed_r: number, st_c: number, ed_c: number, _formula: string) {
        const st_r_c = getNoNullValue(d, st_c, ed_r, 'r');

        if (st_r_c == null) {
            execFormulaInput_c(d, st_r, ed_r, st_c, ed_c, _formula);
        } else {
            activeFormulaInput(cellInput, fxInput, ctx, st_r, st_c, [st_r_c, ed_r - 1], [st_c, ed_c], _formula);
        }
    }

    if (!ctx.selections) return;

    forEach(ctx.selections, (selection) => {
        const [st_r, ed_r] = selection.row;
        const [st_c, ed_c] = selection.column;
        const row_index = selection.row_focus ?? st_r;
        const col_index = selection.column_focus ?? st_c;

        if (st_r === ed_r && st_c === ed_c) {
            if (ed_r - 1 < 0 && ed_c - 1 < 0) {
                activeFormulaInput(cellInput, fxInput, ctx, st_r, st_c, null, null, formula, true);
                return;
            }

            if (ed_r - 1 >= 0 && checkNoNullValue(flowdata[ed_r - 1][st_c])) {
                execFormulaInput(flowdata, st_r, ed_r, st_c, ed_c, formula);
            } else if (ed_c - 1 >= 0 && checkNoNullValue(flowdata[st_r][ed_c - 1])) {
                execFormulaInput_c(flowdata, st_r, ed_r, st_c, ed_c, formula);
            } else {
                execFormulaInput(flowdata, st_r, ed_r, st_c, ed_c, formula);
            }
        } else if (st_r === ed_r) {
            singleFormulaInput(cellInput, fxInput, ctx, flowdata, col_index, st_r, st_c, ed_c, formula, 'r');
        } else if (st_c === ed_c) {
            singleFormulaInput(cellInput, fxInput, ctx, flowdata, row_index, st_c, st_r, ed_r, formula, 'c');
        } else {
            for (let r = st_r; r <= ed_r; r += 1) {
                singleFormulaInput(
                    cellInput,
                    fxInput,
                    ctx,
                    flowdata,
                    col_index,
                    r,
                    st_c,
                    ed_c,
                    formula,
                    'r',
                    true,
                    false,
                );
            }
            for (let c = st_c; c <= ed_c; c += 1) {
                singleFormulaInput(
                    cellInput,
                    fxInput,
                    ctx,
                    flowdata,
                    row_index,
                    c,
                    st_r,
                    ed_r,
                    formula,
                    'c',
                    true,
                    false,
                );
            }
        }
    });
}

export function cancelPaintModel(ctx: Context) {
    // The marching ants are drawn from ctx.formulaRangeSelections, which only shows the current sheet, so a source on
    // another sheet has nothing on screen here.
    if (ctx.painterSource?.sheetId === ctx.currentSheetId) ctx.formulaRangeSelections = [];
    ctx.painterSource = undefined;
}

export function handleNumberFormat(ctx: Context, cellInput: HTMLDivElement, pattern: string) {
    setAttr(ctx, cellInput, 'ct', pattern);
}

export function handleBold(ctx: Context, cellInput: HTMLDivElement) {
    toggleAttr(ctx, cellInput, 'bl');
}

export function handleItalic(ctx: Context, cellInput: HTMLDivElement) {
    toggleAttr(ctx, cellInput, 'it');
}

export function handleFont(ctx: Context, cellInput: HTMLDivElement, fontName: string) {
    setAttr(ctx, cellInput, 'ff', fontName);
}

export function handleStrikeThrough(ctx: Context, cellInput: HTMLDivElement) {
    toggleAttr(ctx, cellInput, 'cl');
}

export function handleUnderline(ctx: Context, cellInput: HTMLDivElement) {
    toggleAttr(ctx, cellInput, 'un');
}

export function handleHorizontalAlign(ctx: Context, cellInput: HTMLDivElement, value: string) {
    setAttr(ctx, cellInput, 'ht', value);
}

export function handleVerticalAlign(ctx: Context, cellInput: HTMLDivElement, value: string) {
    setAttr(ctx, cellInput, 'vt', value);
}

export function handleFormatPainter(ctx: Context) {
    if (ctx.allowEdit === false) return;
    // The painter takes one range, and never one that cuts through a merge.
    const selection = ctx.selections?.length === 1 ? ctx.selections[0] : undefined;
    if (!selection || hasPartMC(ctx, selection.row[0], selection.row[1], selection.column[0], selection.column[1])) {
        return;
    }

    ctx.formulaRangeSelections = [{ row: selection.row, column: selection.column }];
    ctx.painterSource = { sheetId: ctx.currentSheetId, range: { row: selection.row, column: selection.column } };
}

export function handleClearFormat(ctx: Context) {
    if (ctx.allowEdit === false) return;
    const flowdata = getFlowdata(ctx);
    if (!flowdata) return;
    const index = getSheetIndex(ctx, ctx.currentSheetId);
    if (index == null) return;
    const cfg = (ctx.sheets[index].config ??= {});
    for (const selection of ctx.selections ?? []) {
        const [rowSt, rowEd] = selection.row;
        const [colSt, colEd] = selection.column;
        for (let r = rowSt; r <= rowEd; r += 1) {
            if (!isNil(cfg.rowhidden) && !isNil(cfg.rowhidden[r])) {
                continue;
            }
            for (let c = colSt; c <= colEd; c += 1) {
                const cell = flowdata[r][c];
                if (!cell) continue;
                flowdata[r][c] = pick(cell, 'v', 'm', 'mc', 'f', 'ct');
            }
        }
        clearSides(cfg.borderInfo, rowSt, rowEd, colSt, colEd);
    }
}

export function handleTextColor(ctx: Context, cellInput: HTMLDivElement, color: string) {
    setAttr(ctx, cellInput, 'fc', color);
}

export function handleTextBackground(ctx: Context, cellInput: HTMLDivElement, color: string) {
    setAttr(ctx, cellInput, 'bg', color);
}

export function handleBorder(ctx: Context, type: BorderType, borderColor?: string, borderStyle?: string) {
    if (ctx.allowEdit === false) return;

    const index = getSheetIndex(ctx, ctx.currentSheetId);
    if (index == null) return;

    const color = borderColor == null || borderColor === '' ? '#000' : borderColor;
    const style = borderStyle == null || borderStyle === '' ? 1 : Number(borderStyle);
    // Four sides per cell: a header click over 130k rows must not become half a million patches.
    const ranges = clipToUsedExtent(ctx, ctx.selections ?? []);
    applyBorder((ctx.sheets[index].config ??= {}), type, { style, color }, ranges);
}

export function handleMerge(ctx: Context, type: string) {
    if (ctx.allowEdit === false) return;

    if (selectIsOverlap(ctx)) {
        return;
    }

    const merge = getSheetConfig(ctx)?.merge;
    if (merge != null) {
        let has_PartMC = false;
        if (!ctx.selections) return;
        for (let s = 0; s < ctx.selections.length; s += 1) {
            const r1 = ctx.selections[s].row[0];
            const r2 = ctx.selections[s].row[1];
            const c1 = ctx.selections[s].column[0];
            const c2 = ctx.selections[s].column[1];

            has_PartMC = hasPartMC(ctx, r1, r2, c1, c2);

            if (has_PartMC) {
                break;
            }
        }

        if (has_PartMC) {
            return;
        }
    }

    const flowdata = getFlowdata(ctx);
    if (!flowdata) return;

    if (!ctx.selections) return;

    mergeCells(ctx, ctx.currentSheetId, ctx.selections, type);
}

export function handleFreeze(ctx: Context, type: string) {
    if (ctx.allowEdit === false) return;

    const file = ctx.sheets[getSheetIndex(ctx, ctx.currentSheetId)!];
    if (!file) return;

    if (type === 'freeze-cancel') {
        delete file.frozen;
        return;
    }

    const firstSelection = ctx.selections?.[0];
    if (!firstSelection) return;

    let { row_focus, column_focus } = firstSelection;
    if (row_focus == null || column_focus == null) return;

    const m = file.config?.merge?.[`${row_focus}_${column_focus}`];
    if (m) {
        row_focus = m.r + m.rs - 1;
        column_focus = m.c + m.cs - 1;
    }

    file.frozen = { type: 'both', range: { row_focus, column_focus } };
    if (type === 'freeze-row') {
        file.frozen.type = 'rangeRow';
    } else if (type === 'freeze-col') {
        file.frozen.type = 'rangeColumn';
    }
}

export function handleTextSize(ctx: Context, cellInput: HTMLDivElement, size: number) {
    setAttr(ctx, cellInput, 'fs', size);
}

export function handleLink(ctx: Context) {
    if (ctx.allowEdit === false) return;
    const selection = ctx.selections?.[0];
    const flowdata = getFlowdata(ctx);
    if (flowdata != null && selection != null) {
        showLinkCard(ctx, selection.row[0], selection.column[0], true);
    }
}
