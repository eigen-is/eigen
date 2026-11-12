// Reads and writes of single cells in the open sheet, such as a cell's value, its display text and the
// CSS the editor box shows it in. updateCell commits the cell editor or the formula bar into the matrix:
// it runs the formula engine, data validation and the row's auto height. Range helpers that read cells,
// such as getRangeByTxt, live here too.

import { numberDisplay } from '@workspace/formula/format';
import { getFontFamily } from '@workspace/lib/constants/fonts';
import type { BorderSide, MergeCell } from '@workspace/lib/sheets';
import { cellFontName, columnIndexToLabel, SHEET_DEFAULT_FONT_SIZE } from '@workspace/lib/sheets';
import { cloneDeep, isNil, isPlainObject, isString } from 'es-toolkit/compat';
import { sheetRefName } from '../../engine/a1-notation';
import type { CellFormatStyle, ComputeMap } from '../../engine/conditional-format';
import {
    booleanDisplay,
    cellWrapsText,
    dropRuns,
    generalAlign,
    parseCellInput,
    richText,
    writeFormulaResult,
} from '../../engine/format';
import { iscelldata, isFormula } from '../../engine/formula-utils';
import type { Cell, CellMatrix, FormulaDependency } from '../../engine/types';
import { getSheet } from '../api/common';
import type { Context } from '../context';
import { getFlowdata, getSheetConfig } from '../context';
import type { RangeOrWholeAxis, Selection } from '../types';
import { getSheetIndex, rgbToHex } from '../utils';
import { checkCF, getComputeMap } from './condition-format';
import { describeValidationRule, inputPassesRule } from './data-validation';
import { functionHTMLGenerate } from './formula-editor';
import { computeFormula, getcellrange } from './formula-exec';
import type { RunStyleKey } from './inline-string';
import {
    committedRuns,
    DEFAULT_TEXT_COLOR,
    hexColor,
    isInlineStringCell,
    runStyleOf,
    runsHtml,
    sameRunStyle,
} from './inline-string';
import { recomputeCells } from './refresh';
import { growRowToFit } from './text';
import { ID_CARD_NUMBER, isPlainNumber, isRealNull, isRealNum, valueIsError } from './validation';
import { validationAt } from './validation-rules';

// Returns the cell attribute value, normalized to a default when missing. The result is a union of strings and numbers
// that callers narrow per attr.
// biome-ignore lint/suspicious/noExplicitAny: per-attr return shape varies (string default vs Cell[attr]); tightening forces casts at every call site
export function normalizedCellAttr(cell: Cell, attr: keyof Cell): any {
    const tf = { bl: 1, it: 1, ff: 1, cl: 1, un: 1 };
    // biome-ignore lint/suspicious/noExplicitAny: same union as the return type
    let value: any = cell[attr];

    if (attr in tf || (attr === 'fs' && isInlineStringCell(cell))) {
        value ||= '0';
    } else if (['fc', 'bg', 'bc'].includes(attr)) {
        if (['fc', 'bc'].includes(attr)) {
            value ||= '#000000';
        }
        if (value?.indexOf('rgba') > -1) {
            value = rgbToHex(value);
        }
    } else if (attr.substring(0, 2) === 'bs') {
        value ||= 'none';
    } else if (attr === 'ht' || attr === 'vt') {
        const defaultValue = attr === 'ht' ? generalAlign(cell) : '0';
        value = !isNil(value) ? value.toString() : defaultValue;
        if (['0', '1', '2'].indexOf(value.toString()) === -1) {
            value = defaultValue;
        }
    } else if (attr === 'fs') {
        value ||= String(SHEET_DEFAULT_FONT_SIZE);
    } else if (attr === 'tb') {
        // Text overflows unless set to clip ('0') or wrap ('2'), as in Google Sheets and Excel.
        value ||= '1';
    }

    return value;
}

// biome-ignore lint/suspicious/noExplicitAny: passes through normalizedCellAttr's per-attr union
export function normalizedAttr(data: CellMatrix, r: number, c: number, attr: keyof Cell): any {
    if (!data[r]) {
        return null;
    }
    const cell = data[r][c];
    if (!cell) return undefined;
    return normalizedCellAttr(cell, attr);
}

// A cell's formula, or the value or display text a reader takes as text: a date reads as the date it shows, and a rich
// cell as its runs. Null when the cell has none.
export function getCellValue(r: number, c: number, data: CellMatrix, attr: 'v' | 'm' | 'f' = 'v') {
    const cell = data[r][c];
    if (!cell) return null;
    if (attr === 'f') return cell.f ?? null;
    return (cell.ct?.t === 'd' ? cell.m : (richText(cell) ?? cell[attr])) ?? null;
}

// `v` is a scalar, a Cell-like patch ({v, f, ct, …}) or null.
// biome-ignore lint/suspicious/noExplicitAny: cross-cutting setter, callers pass scalars and Cell-like patches indistinguishably
export function setCellValue(ctx: Context, r: number, c: number, d: CellMatrix | null | undefined, v: any) {
    if (isNil(d)) {
        d = getFlowdata(ctx);
    }
    if (!d) return;

    let cell = d[r][c];

    // biome-ignore lint/suspicious/noExplicitAny: tracks v's shape (scalar or cell.v from a patch)
    let value: any;

    if (isPlainObject(v)) {
        if (isNil(cell)) {
            cell = v;
        } else {
            if (!isNil(v.f)) {
                cell.f = v.f;
            } else if ('f' in cell) {
                delete cell.f;
            }

            if (!isNil(v.ct)) {
                cell.ct = v.ct;
            }
        }

        if (isPlainObject(v.v)) {
            value = v.v.v;
        } else {
            value = v.v;
        }
    } else {
        value = v;
    }

    // A rich write, runs with no value or formula, brings its runs; any other write drops the cell's.
    if (cell != null && !(isPlainObject(v) && isNil(v.f) && isRealNull(value) && richText(v) !== undefined)) {
        dropRuns(cell);
    }

    if (cell?.f != null) {
        writeFormulaResult(cell, value);
        d[r][c] = cell;
        return;
    }

    if (isRealNull(value)) {
        if (cell != null && isPlainObject(cell)) {
            delete cell.m;
            delete cell.v;
        } else {
            cell = null;
        }

        d[r][c] = cell;

        return;
    }

    cell ??= {};

    const text = value.toString();

    if (text.startsWith("'")) {
        cell.m = text.slice(1);
        cell.ct = { fa: '@', t: 's' };
        cell.v = text.slice(1);
        cell.qp = 1;
    } else if (cell.qp === 1) {
        cell.m = text;
        cell.ct = { fa: '@', t: 's' };
        cell.v = text;
    } else if (text.toUpperCase() === 'TRUE' && cell.ct?.fa !== '@') {
        cell.m = booleanDisplay(true);
        cell.ct = { fa: 'General', t: 'b' };
        cell.v = true;
    } else if (text.toUpperCase() === 'FALSE' && cell.ct?.fa !== '@') {
        cell.m = booleanDisplay(false);
        cell.ct = { fa: 'General', t: 'b' };
        cell.v = false;
    } else if (text.endsWith('%') && isRealNum(text.substring(0, text.length - 1)) && cell.ct?.fa !== '@') {
        cell.ct = { fa: '0%', t: 'n' };
        cell.v = text.substring(0, text.length - 1) / 100;
        cell.m = value;
    } else if (valueIsError(value) && cell.ct?.fa !== '@') {
        // An error typed into a text-formatted cell stays text, as in Excel, so only other cells get here.
        cell.m = text;
        if (!isNil(cell.ct)) {
            cell.ct.t = 'e';
        } else {
            cell.ct = { fa: 'General', t: 'e' };
        }
        cell.v = value;
    } else {
        if (!isNil(cell.ct) && cell.ct.fa === '@') {
            cell.m = text;
            cell.v = value;
        } else if (cell.ct != null && cell.ct.t === 'd' && isString(value)) {
            const mask = parseCellInput(value);
            if (mask[1].t !== 'd' || mask[1].fa === cell.ct.fa) {
                [cell.m, cell.ct, cell.v] = mask;
            } else {
                [, , cell.v] = mask;
                cell.m = numberDisplay(cell.v, cell.ct.fa);
            }
        } else if (!isNil(cell.ct) && !isNil(cell.ct.fa) && cell.ct.fa !== 'General') {
            if (isPlainNumber(value)) {
                value = Number(value);
            }

            const mask = numberDisplay(value, cell.ct.fa);

            if (mask === value) {
                // A format the updated value can't take is replaced by the value's own.
                [cell.m, cell.ct, cell.v] = parseCellInput(value);
            } else {
                cell.m = mask;
                cell.v = value;
            }
        } else {
            if (isPlainNumber(value) && !ID_CARD_NUMBER.test(text)) {
                cell.v = Number(value);
                cell.ct = { fa: 'General', t: 'n' };
                cell.m = numberDisplay(cell.v);
            } else {
                [cell.m, cell.ct, cell.v] = parseCellInput(value);
            }
        }
    }

    d[r][c] = cell;
}

export function getRealCellValue(r: number, c: number, data: CellMatrix) {
    return getCellValue(r, c, data, 'm') ?? getCellValue(r, c, data);
}

// A number stored as text (qp === 1) that still reads as a number, which the painter marks in the cell's corner.
export function isForcedStringNumber(cell: Cell | null | undefined): boolean {
    return cell?.qp === 1 && !Number.isNaN(Number(cell.v));
}

export function mergeBorder(ctx: Context, d: CellMatrix, row_index: number, col_index: number) {
    if (!d[row_index]) {
        return null;
    }
    const value = d[row_index][col_index];
    if (!value) return null;

    if (value.mc) {
        col_index = value.mc.c;
        row_index = value.mc.r;

        if (isNil(d[row_index]?.[col_index])) {
            return null;
        }
        const col_rs = d[row_index]?.[col_index]?.mc?.cs;
        const row_rs = d[row_index]?.[col_index]?.mc?.rs;
        const mergeMain = d[row_index]?.[col_index]?.mc;

        if (!mergeMain || isNil(mergeMain?.rs) || isNil(mergeMain?.cs) || isNil(col_rs) || isNil(row_rs)) {
            return null;
        }

        let start_r: number;
        let end_r: number;
        let row: number | undefined;
        let row_pre: number | undefined;
        for (let r = row_index; r < mergeMain.rs + row_index; r += 1) {
            if (r === 0) {
                start_r = -1;
            } else {
                start_r = ctx.visibledatarow[r - 1] - 1;
            }

            end_r = ctx.visibledatarow[r];

            if (row_pre === undefined) {
                row_pre = start_r;
                row = end_r;
            } else if (row !== undefined) {
                row += end_r - start_r - 1;
            }
        }

        let start_c: number;
        let end_c: number;
        let col: number | undefined;
        let col_pre: number | undefined;

        for (let c = col_index; c < mergeMain.cs + col_index; c += 1) {
            if (c === 0) {
                start_c = 0;
            } else {
                start_c = ctx.visibledatacolumn[c - 1];
            }

            end_c = ctx.visibledatacolumn[c];

            if (col_pre === undefined) {
                col_pre = start_c;
                col = end_c;
            } else if (col !== undefined) {
                col += end_c - start_c;
            }
        }

        if (isNil(row_pre) || isNil(col_pre) || isNil(row) || isNil(col)) {
            return null;
        }

        return {
            row: [row_pre, row, row_index, row_index + row_rs - 1],
            column: [col_pre, col, col_index, col_index + col_rs - 1],
        };
    }
    return null;
}

function mergeMove(
    ctx: Context,
    mc: MergeCell,
    columnSelected: number[],
    rowSelected: number[],
    top: number,
    height: number,
    left: number,
    width: number,
): [number[], number[], number, number, number, number] | null {
    const row_st = mc.r;
    const row_ed = mc.r + mc.rs - 1;
    const col_st = mc.c;
    const col_ed = mc.c + mc.cs - 1;
    let matched = false;

    columnSelected[0] = Math.min(columnSelected[0], columnSelected[1]);
    rowSelected[0] = Math.min(rowSelected[0], rowSelected[1]);

    if (
        (columnSelected[0] <= col_st &&
            columnSelected[1] >= col_ed &&
            rowSelected[0] <= row_st &&
            rowSelected[1] >= row_ed) ||
        (!(columnSelected[1] < col_st || columnSelected[0] > col_ed) &&
            !(rowSelected[1] < row_st || rowSelected[0] > row_ed))
    ) {
        const flowdata = getFlowdata(ctx);
        if (!flowdata) return null;

        const mergeset = mergeBorder(ctx, flowdata, mc.r, mc.c);
        if (mergeset) {
            const row = mergeset.row[1];
            const row_pre = mergeset.row[0];
            const col = mergeset.column[1];
            const col_pre = mergeset.column[0];

            if (!(columnSelected[1] < col_st || columnSelected[0] > col_ed)) {
                if (rowSelected[0] <= row_ed && rowSelected[0] >= row_st) {
                    height += top - row_pre;
                    top = row_pre;
                    rowSelected[0] = row_st;
                }

                if (rowSelected[1] >= row_st && rowSelected[1] <= row_ed) {
                    height = row - top;

                    rowSelected[1] = row_ed;
                }
            }

            if (!(rowSelected[1] < row_st || rowSelected[0] > row_ed)) {
                if (columnSelected[0] <= col_ed && columnSelected[0] >= col_st) {
                    width += left - col_pre;
                    left = col_pre;
                    columnSelected[0] = col_st;
                }

                if (columnSelected[1] >= col_st && columnSelected[1] <= col_ed) {
                    width = col - left;

                    columnSelected[1] = col_ed;
                }
            }

            matched = true;
        }
    }

    if (matched) {
        return [columnSelected, rowSelected, top, height, left, width];
    }
    return null;
}

export function mergeMoveMain(
    ctx: Context,
    columnSelected: number[],
    rowSelected: number[],
    top: number,
    height: number,
    left: number,
    width: number,
): [number[], number[], number, number, number, number] | null {
    const mergesetting = getSheetConfig(ctx)?.merge;

    if (!mergesetting) {
        return null;
    }

    const mcset = Object.keys(mergesetting);

    rowSelected[1] = Math.max(rowSelected[0], rowSelected[1]);
    columnSelected[1] = Math.max(columnSelected[0], columnSelected[1]);

    let offloop = true;
    const mergeMoveData: Record<string, MergeCell> = {};

    while (offloop) {
        offloop = false;

        for (let i = 0; i < mcset.length; i += 1) {
            const key = mcset[i];
            const mc = mergesetting[key];

            if (key in mergeMoveData) {
                continue;
            }

            const changeparam = mergeMove(ctx, mc, columnSelected, rowSelected, top, height, left, width);

            if (changeparam != null) {
                mergeMoveData[key] = mc;

                [columnSelected, rowSelected, top, height, left, width] = changeparam;

                offloop = true;
            }
        }
    }

    return [columnSelected, rowSelected, top, height, left, width];
}

export function cancelFunctionrangeSelected(ctx: Context) {
    if (ctx.formulaCache.selectingRangeIndex === -1) {
        ctx.formulaRangeSelect = undefined;
    }
}

// Ends the open edit, committed or not, and closes the formula popups. updateCell runs it after the write.
export function cancelNormalSelected(ctx: Context) {
    cancelFunctionrangeSelected(ctx);

    ctx.editingCellPosition = [];
    ctx.formulaRangeHighlight = [];
    ctx.functionHint = null;
    ctx.functionCandidates = [];

    ctx.formulaCache.rangestart = false;
    ctx.formulaCache.rangedrag_column_start = false;
    ctx.formulaCache.rangedrag_row_start = false;
}

export function updateCell(
    ctx: Context,
    r: number,
    c: number,
    $input?: HTMLDivElement | null,
    // biome-ignore lint/suspicious/noExplicitAny: forwarded straight to setCellValue, same scalar/Cell-patch union
    value?: any,
) {
    const inputText = $input?.innerText;
    const flowdata = getFlowdata(ctx);
    if (!flowdata) return;

    const sheet = getSheet(ctx);
    const rule = validationAt(sheet.dataValidations, r, c);
    if (rule?.prohibitInput && !inputPassesRule(ctx, rule, flowdata[r][c], inputText)) {
        cancelNormalSelected(ctx);
        ctx.warnDialog = describeValidationRule(rule, 'invalid');
        return;
    }

    let curv = flowdata[r][c];

    const isPrevInline = isInlineStringCell(curv);
    // Typed text is rich when its runs differ from the cell's own style or break the line. Text that is
    // all in the cell's style commits plain, as a formula always does.
    const runs = $input && !value && inputText?.slice(0, 1) !== '=' ? committedRuns($input, curv) : [];
    const isCurInline =
        runs.length > 1 ||
        runs.some((run) => run.v.includes('\n')) ||
        (runs.length === 1 && !sameRunStyle(runs[0], runStyleOf(curv)));

    if (curv?.ct && !value && !isCurInline && isPrevInline) {
        delete curv.ct.s;
        curv.ct.t = 'g';
        curv.ct.fa = 'General';
        value = '';
    } else if (isCurInline) {
        curv = isPlainObject(curv) && curv ? curv : {};
        curv.ct = { ...curv.ct, fa: curv.ct?.fa ?? 'General', t: 'inlineStr', s: runs };
        delete curv.f;
        delete curv.v;
        delete curv.m;
        curv.fs ||= SHEET_DEFAULT_FONT_SIZE;
    }

    value = value || (runs.length === 1 && !isCurInline ? runs[0].v : $input?.innerText);

    if (!isCurInline) {
        if (isRealNull(value) && !isPrevInline) {
            if (!curv || (isRealNull(curv.v) && !curv.f)) {
                cancelNormalSelected(ctx);
                return;
            }
        } else if (curv && curv.qp !== 1) {
            if (isPlainObject(curv) && (value === curv.f || value === curv.v || value === curv.m)) {
                cancelNormalSelected(ctx);
                return;
            }
        }

        const typesFormula = isString(value) && value.slice(0, 1) === '=' && value.length > 1;
        if (!typesFormula && isPlainObject(curv) && curv?.ct?.fa && curv.ct.fa !== '@' && !isRealNull(value)) {
            delete curv.m;
            delete curv.f;
        }
    }

    if (curv && isPlainObject(curv)) {
        if (!isCurInline) {
            if (isFormula(value)) {
                const computed = computeFormula(ctx, value);
                curv = cloneDeep(flowdata[r][c] || {});
                [curv.v, curv.f] = computed;
            } else {
                curv = cloneDeep(flowdata[r][c] || {});
                curv.v = value;

                delete curv.f;

                if (curv.qp === 1 && `${value}`.substring(0, 1) !== "'") {
                    // Editing a forced-string cell clears its quote prefix.
                    curv.qp = 0;
                    if (curv.ct) {
                        curv.ct.fa = 'General';
                        curv.ct.t = 'n';
                    }
                }
            }
        }
        value = curv;
    } else if (isFormula(value)) {
        const [v, f] = computeFormula(ctx, value);
        value = { v, f };
    }

    setCellValue(ctx, r, c, flowdata, value);
    cancelNormalSelected(ctx);

    const written = flowdata[r][c];
    if (written && ((cellWrapsText(written) && written.v) || isInlineStringCell(written))) {
        growRowToFit(ctx, (sheet.config ??= {}), written, r, c);
    }

    recomputeCells(ctx, [{ r, c, id: ctx.currentSheetId }]);
}

export function getcellFormula(ctx: Context, r: number, c: number, i: string, data?: CellMatrix) {
    // `data` is a fast path for the current sheet. A cell of another sheet may name a row it lacks.
    const row = data?.[r] ?? getFlowdata(ctx, i)?.[r];
    return row?.[c]?.f ?? null;
}

function isWholeColumnRef(range: RangeOrWholeAxis): range is { row: [null, null]; column: number[] } {
    return range.row[0] === null && range.column[0] !== null;
}
function isWholeRowRef(range: RangeOrWholeAxis): range is { row: number[]; column: [null, null] } {
    return range.row[0] !== null && range.column[0] === null;
}

// A range as text like A1:A2. Null rows make a whole-column ref (`A:A`), null columns a whole-row ref (`1:1`).
export function getRangetxt(ctx: Context, sheetId: string, range: RangeOrWholeAxis, currentId?: string) {
    let sheettxt = '';

    if (currentId == null) {
        currentId = ctx.currentSheetId;
    }

    if (sheetId !== currentId) {
        const index = getSheetIndex(ctx, sheetId);
        if (index == null) return '';
        sheettxt = `${sheetRefName(ctx.sheets[index].name)}!`;
    }

    if (isWholeColumnRef(range)) {
        return `${sheettxt + columnIndexToLabel(range.column[0])}:${columnIndexToLabel(range.column[1])}`;
    }
    if (isWholeRowRef(range)) {
        return `${sheettxt + (range.row[0] + 1)}:${range.row[1] + 1}`;
    }

    const { row, column } = range;
    if (column[0] === column[1] && row[0] === row[1]) {
        return sheettxt + columnIndexToLabel(column[0]) + (row[0] + 1);
    }
    return `${sheettxt + columnIndexToLabel(column[0]) + (row[0] + 1)}:${columnIndexToLabel(column[1])}${row[1] + 1}`;
}

export function getRangeByTxt(ctx: Context, txt: string) {
    let range: (FormulaDependency | null)[] = [];
    if (txt.indexOf(',') !== -1) {
        const arr = txt.split(',');
        for (let i = 0; i < arr.length; i += 1) {
            if (iscelldata(arr[i])) {
                range.push(getcellrange(ctx, arr[i]));
            } else {
                range = [];
                break;
            }
        }
    } else {
        if (iscelldata(txt)) {
            range.push(getcellrange(ctx, txt));
        }
    }
    return range;
}

// Whether every selected cell has `status` for a style key, which decides if a toolbar toggle such as Bold turns it on
// or off.
export function isAllSelectedCellsInStatus(ctx: Context, attr: RunStyleKey, status: unknown) {
    const flowdata = getFlowdata(ctx);
    return (ctx.selections ?? []).every(({ row, column }) => {
        for (let r = row[0]; r <= row[1]; r += 1) {
            for (let c = column[0]; c <= column[1]; c += 1) {
                const cell = flowdata?.[r]?.[c];
                if (isNil(cell) || cell[attr] !== status) return false;
            }
        }
        return true;
    });
}

// The font part of a cell's CSS, for the editor box and the copied HTML. The cell is read as its runs are, so the box
// and the runs typed in it agree, and only the keys the cell sets write CSS.
function getFontStyleByCell(cell: Cell | null | undefined, checksCF?: CellFormatStyle | null) {
    const style: Record<string, string> = {};
    if (!cell) {
        return style;
    }
    const { bl, it, cl, fs, fc } = runStyleOf(cell);
    if (bl) style.fontWeight = 'bold';
    if (it) style.fontStyle = 'italic';
    const font = cellFontName(cell.ff);
    if (font) style.fontFamily = getFontFamily(font);
    if (fs !== SHEET_DEFAULT_FONT_SIZE) style.fontSize = `${fs}pt`;
    const color = hexColor(checksCF?.textColor) ?? fc;
    if (color !== DEFAULT_TEXT_COLOR) style.color = color;
    if (cl) style.textDecoration = 'line-through';
    const underline = Number(cell.un);
    if (underline === 1 || underline === 3) style.borderBottom = `${Math.floor(fs / 9)}px solid ${color}`;
    return style;
}

export function getStyleByCell(ctx: Context, d: CellMatrix, r: number, c: number, cfCompute?: ComputeMap | null) {
    const style: Record<string, string> = {};

    const cf_compute = cfCompute ?? getComputeMap(ctx);
    const checksCF = checkCF(r, c, cf_compute);

    const cell = d?.[r]?.[c];
    if (!cell) return {};

    const background = hexColor(checksCF?.cellColor) ?? hexColor(cell.bg);
    if (background) style.background = background;
    if ('ht' in cell) {
        const value = normalizedCellAttr(cell, 'ht');
        if (Number(value) === 0) {
            style.textAlign = 'center';
        } else if (Number(value) === 2) {
            style.textAlign = 'right';
        }
    }

    if ('vt' in cell) {
        const value = normalizedCellAttr(cell, 'vt');
        if (Number(value) === 0) {
            style.alignItems = 'center';
        } else if (Number(value) === 2) {
            style.alignItems = 'flex-end';
        }
    }
    // A rich cell's box shows its own style too: its spans state only where a run differs from it.
    return Object.assign(style, getFontStyleByCell(cell, checksCF));
}

// The formula as the colored spans the formula bar and the in-cell editor show. Null on a cell with no formula: the
// two editors disagree about rich text, so the fallback belongs to them.
export function getFormulaHtml(r: number, c: number, data: CellMatrix): string | null {
    const f = getCellValue(r, c, data, 'f');
    return isNil(f) ? null : functionHTMLGenerate(String(f));
}

// A rich cell's runs as the spans the in-cell editor opens with. The text and the CSS are escaped: both
// come from the cell, which any collaborator or an uploaded xlsx wrote.
export function getInlineStringHTML(r: number, c: number, data: CellMatrix) {
    const cell = data[r]?.[c];
    return isInlineStringCell(cell) ? runsHtml(cell.ct.s, runStyleOf(cell)) : '';
}

export function getQKBorder(width: string, type: string, color: string): BorderSide {
    const nWidth = parseFloat(width);
    const [medium, thick] = width.includes('pt') ? [1, 1.5] : [2, 3];
    let bordertype = '';
    if (!(nWidth < medium)) bordertype = nWidth < thick ? 'Medium' : 'Thick';

    let style = 0;
    type = type.toLowerCase();

    if (type === 'double') {
        style = 2;
    } else if (type === 'dotted') {
        if (bordertype === 'Medium' || bordertype === 'Thick') {
            style = 3;
        } else {
            style = 10;
        }
    } else if (type === 'dashed') {
        if (bordertype === 'Medium' || bordertype === 'Thick') {
            style = 4;
        } else {
            style = 9;
        }
    } else if (type === 'solid') {
        if (bordertype === 'Medium') {
            style = 8;
        } else if (bordertype === 'Thick') {
            style = 13;
        } else {
            style = 1;
        }
    }

    return { style, color };
}

export function getDataBySelectionNoCopy(ctx: Context, range: Selection) {
    if (!range?.row || range.row.length === 0) return [];
    const data = [];
    const flowData = getFlowdata(ctx);
    if (!flowData) return [];
    const cfg = getSheetConfig(ctx);
    for (let r = range.row[0]; r <= range.row[1]; r += 1) {
        const row = [];
        if (cfg?.rowhidden?.[r] != null) {
            continue;
        }
        for (let c = range.column[0]; c <= range.column[1]; c += 1) {
            let value = null;
            if (cfg?.colhidden?.[c] != null) {
                continue;
            }
            if (flowData[r] != null && flowData[r][c] != null) {
                value = flowData[r][c];
            }

            row.push(value);
        }

        data.push(row);
    }
    return data;
}
