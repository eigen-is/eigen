// The actions of the format toolbar and the Format menu on the selection, such as bold, the font, a
// number format, borders and merging. Each runs inside a setContext recipe. While a cell is open on
// text, a font format goes to the editor's selected characters rather than to the cells.

import { numberDisplay } from '@workspace/formula/format';
import type { BorderType } from '@workspace/lib/sheets';
import { pick } from 'es-toolkit/compat';
import { is_date, writeFormulaResult } from '../../engine/format';
import type { Cell, CellMatrix } from '../../engine/types';
import type { Context } from '../context';
import { getFlowdata } from '../context';
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

// A cell stores its alignment as the index of its name here: `ht` 0 is center, 1 left and 2 right.
export const HORIZONTAL_ALIGNS = ['center', 'left', 'right'] as const;
export const VERTICAL_ALIGNS = ['middle', 'top', 'bottom'] as const;

const WRAP_CODES: Record<string, string> = { overflow: '1', clip: '0', wrap: '2' };

export function updateFormatCell(
    ctx: Context,
    d: CellMatrix,
    attr: keyof Cell,
    value: string | number,
    rowStart: number,
    rowEnd: number,
    colStart: number,
    colEnd: number,
) {
    const sheetIndex = getSheetIndex(ctx, ctx.currentSheetId);
    if (sheetIndex == null) return;
    const cfg = (ctx.sheets[sheetIndex].config ??= {});
    if (attr === 'tb') value = WRAP_CODES[value] ?? value;

    for (let r = rowStart; r <= rowEnd; r += 1) {
        if (cfg.rowhidden?.[r] != null) continue;

        for (let c = colStart; c <= colEnd; c += 1) {
            const cell = d[r][c];
            if (attr === 'ct') {
                const fa = String(value);
                if (cell?.f != null) {
                    // The result keeps the type it has, so a format makes no number of a text result.
                    (cell.ct ??= {}).fa = fa;
                    writeFormulaResult(cell, cell.v);
                    continue;
                }

                const v = fa !== '@' && isRealNum(cell?.v) ? Number(cell?.v) : cell?.v;
                const m = numberDisplay(v, fa);
                let t = 'n';
                if (is_date(fa)) t = 'd';
                else if (fa === '@') t = 's';
                else if (fa === 'General' && !isRealNum(v)) t = 'g';

                if (cell) {
                    cell.m = m;
                    Object.assign((cell.ct ??= {}), { fa, t });
                } else {
                    d[r][c] = { ct: { fa, t }, v, m };
                }
            } else if (cell) {
                if (isRunStyleKey(attr)) updateInlineStringFormatOutside(cell, attr, value);
                Object.assign(cell, { [attr]: value });
                // A larger size or wrapped lines need a taller row.
                if (attr === 'fs' || (attr === 'tb' && value === '2')) growRowToFit(ctx, cfg, cell, r, c);
            } else {
                d[r][c] = { [attr]: value };
            }
        }
    }
}

export function updateFormat(
    ctx: Context,
    cellInput: HTMLDivElement,
    d: CellMatrix,
    attr: keyof Cell,
    value: string | number,
) {
    if (ctx.allowEdit === false) return;

    if (isRunStyleKey(attr) && isEditingText(ctx, cellInput)) {
        const [r, c] = ctx.editingCellPosition;
        formatEditorSelection(cellInput, d[r]?.[c], attr, value);
        return;
    }

    for (const { row, column } of ctx.selections ?? []) {
        updateFormatCell(ctx, d, attr, value, row[0], row[1], column[0], column[1]);
    }
}

// While a cell is open on text, not a formula, a font format applies to the editor's selected
// characters, and to a new cell as well as a filled one.
function isEditingText(ctx: Context, cellInput: HTMLDivElement) {
    return ctx.editingCellPosition.length > 0 && !cellInput.innerText.startsWith('=');
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

export function handleHorizontalAlign(
    ctx: Context,
    cellInput: HTMLDivElement,
    align: (typeof HORIZONTAL_ALIGNS)[number],
) {
    setAttr(ctx, cellInput, 'ht', HORIZONTAL_ALIGNS.indexOf(align));
}

export function handleVerticalAlign(ctx: Context, cellInput: HTMLDivElement, align: (typeof VERTICAL_ALIGNS)[number]) {
    setAttr(ctx, cellInput, 'vt', VERTICAL_ALIGNS.indexOf(align));
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
            if (cfg.rowhidden?.[r] != null) continue;
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

    const color = borderColor || '#000';
    const style = borderStyle ? Number(borderStyle) : 1;
    // Four sides per cell: a header click over 130k rows must not become half a million patches.
    const ranges = clipToUsedExtent(ctx, ctx.selections ?? []);
    applyBorder((ctx.sheets[index].config ??= {}), type, { style, color }, ranges);
}

export function handleMerge(ctx: Context, type: string) {
    const { selections } = ctx;
    if (ctx.allowEdit === false || !selections || selectIsOverlap(ctx)) return;
    if (selections.some(({ row, column }) => hasPartMC(ctx, row[0], row[1], column[0], column[1]))) return;

    mergeCells(ctx, ctx.currentSheetId, selections, type);
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
