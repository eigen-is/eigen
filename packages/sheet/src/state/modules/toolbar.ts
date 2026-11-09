// The actions of the format toolbar and the Format menu on the selection, such as bold, the font, a
// number format, borders and merging. Each runs inside a setContext recipe. While a cell is open on
// text, a font format goes to the editor's selected characters rather than to the cells.

import type { BorderType } from '@workspace/lib/sheets';
import { isNil, isPlainObject, pick } from 'es-toolkit/compat';
import { is_date, numberDisplay, writeFormulaResult } from '../../engine/format';
import type { Cell, CellMatrix } from '../../engine/types';
import type { Context } from '../context';
import { getFlowdata, getSheetConfig } from '../context';
import { clipToUsedExtent, getSheetIndex } from '../utils';
import { applyBorder, clearSides } from './border';
import { isAllSelectedCellsInStatus } from './cell';
import { showLinkCard } from './hyperlink';
import {
    editorSelectionStyle,
    formatEditorSelection,
    isRunStyleKey,
    updateInlineStringFormatOutside,
} from './inline-string';
import { mergeCells } from './merge';
import { selectIsOverlap } from './selection';
import { growRowToFit } from './text';
import { hasPartMC, isRealNum } from './validation';

export function updateFormatCell(
    ctx: Context,
    d: CellMatrix,
    attr: keyof Cell,
    status: string | number,
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
        const fa = String(status);
        for (let r = row_st; r <= row_ed; r += 1) {
            if (!isNil(cfg.rowhidden) && !isNil(cfg.rowhidden[r])) {
                continue;
            }

            for (let c = col_st; c <= col_ed; c += 1) {
                const cell = d[r][c];
                if (cell?.f != null) {
                    // The result keeps the type it has, so a format makes no number of a text result.
                    (cell.ct ??= {}).fa = fa;
                    writeFormulaResult(cell, cell.v);
                    continue;
                }

                let value = cell?.v;
                if (fa !== '@' && isRealNum(value)) {
                    value = Number(value);
                }

                const mask = numberDisplay(value, fa);
                let type = 'n';
                if (is_date(fa)) {
                    type = 'd';
                } else if (fa === '@') {
                    type = 's';
                } else if (fa === 'General') {
                    type = isRealNum(value) ? 'n' : 'g';
                }

                if (cell && isPlainObject(cell)) {
                    cell.m = `${mask}`;
                    if (isNil(cell.ct)) {
                        cell.ct = {};
                    }
                    cell.ct.fa = fa;
                    cell.ct.t = type;
                } else {
                    d[r][c] = {
                        ct: { fa, t: type },
                        v: value,
                        m: mask,
                    };
                }
            }
        }
    } else {
        if (attr === 'ht') {
            if (status === 'left') {
                status = '1';
            } else if (status === 'center') {
                status = '0';
            } else if (status === 'right') {
                status = '2';
            }
        } else if (attr === 'vt') {
            if (status === 'top') {
                status = '1';
            } else if (status === 'middle') {
                status = '0';
            } else if (status === 'bottom') {
                status = '2';
            }
        } else if (attr === 'tb') {
            if (status === 'overflow') {
                status = '1';
            } else if (status === 'clip') {
                status = '0';
            } else if (status === 'wrap') {
                status = '2';
            }
        }

        for (let r = row_st; r <= row_ed; r += 1) {
            if (!isNil(cfg.rowhidden) && !isNil(cfg.rowhidden[r])) {
                continue;
            }

            for (let c = col_st; c <= col_ed; c += 1) {
                const value = d[r][c];

                if (value && isPlainObject(value)) {
                    if (isRunStyleKey(attr)) updateInlineStringFormatOutside(value, attr, status);
                    Object.assign(value, { [attr]: status });
                    // A larger size or wrapped lines need a taller row.
                    if (attr === 'fs' || (attr === 'tb' && status === '2')) growRowToFit(ctx, cfg, value, r, c);
                } else {
                    d[r][c] = { [attr]: status };
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
    status: string | number,
) {
    if (ctx.allowEdit === false) return;

    if (isRunStyleKey(attr) && isEditingText(ctx, $input)) {
        const [r, c] = ctx.editingCellPosition;
        formatEditorSelection($input, d[r]?.[c], attr, status);
        return;
    }

    for (const { row, column } of ctx.selections ?? []) {
        updateFormatCell(ctx, d, attr, status, row[0], row[1], column[0], column[1]);
    }
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
                flowdata[r][c] = pick(cell, 'v', 'm', 'mc', 'f', 'ct', 'link', 'commentCardIds');
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

    const index = getSheetIndex(ctx, ctx.currentSheetId);
    if (index == null) return;
    const file = ctx.sheets[index];

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
