import { escapeHtml } from '@workspace/lib/html';
import type { BorderSide, CellBorderInfo, ConditionalFormatRule, DataVerificationRule } from '@workspace/lib/sheets';
import { cloneDeep, isEmpty, isNil, isNumber } from 'es-toolkit/compat';
import { format } from 'numfmt';
import { cfSplitRange } from '../../engine/conditional-format';
import { update } from '../../engine/format';
import { type Context, getFlowdata } from '../context';
import type { CalcChainEntry, Cell, Range, Selection, Sheet as SheetType, SingleRange } from '../types';
import { getSheetIndex, isAllowEdit, replaceHtml, styleObjectToCss } from '../utils';
import { BORDER_STYLE_NAMES, type ComputedBorderEntry, getBorderInfoCompute } from './border';
import {
    getCellValue,
    getDataBySelectionNoCopy,
    getdatabyselection,
    getStyleByCell,
    mergeBorder,
    mergeMoveMain,
} from './cell';
import { setPendingCopy } from './clipboard';
import { getComputeMap } from './condition-format';
import { hasPartMC } from './validation';

export const selectionCache = {
    isPasteAction: false,
};

// HTML copy-export builds a histogram of border colors and line styles along
// each side of a merged cell so it can pick the dominant value (>= half the
// edge length) for the rendered `<td>` border.
type BorderEdgeHistogram = { color: Record<string, number>; style: Record<string, number> };

function bumpHistogram(hist: BorderEdgeHistogram, side: BorderSide) {
    hist.style[side.style] = (hist.style[side.style] ?? 0) + 1;
    hist.color[side.color] = (hist.color[side.color] ?? 0) + 1;
}

// Pick the dominant color and line-style along one merged-cell edge — each must
// appear on at least half the edge's cells — and render it as a CSS declaration.
// An empty histogram serializes to exactly 23 chars, so `> 23` means "saw a border".
function dominantBorderSideCss(hist: BorderEdgeHistogram, edgeLen: number, cssSide: string): string {
    if (JSON.stringify(hist).length <= 23) return '';

    let color: string | null = null;
    let style: string | null = null;
    for (const key of Object.keys(hist.color)) {
        if (hist.color[key] >= edgeLen / 2) color = key;
    }
    for (const key of Object.keys(hist.style)) {
        if (hist.style[key] >= edgeLen / 2) style = key;
    }

    if (!isNil(color) && !isNil(style)) {
        return `border-${cssSide}:${getHtmlBorderStyle(style, color)}`;
    }
    return '';
}

function cellBorderCss(border: ComputedBorderEntry): string {
    let css = '';
    if (border.l) css += `border-left:${getHtmlBorderStyle(border.l.style, border.l.color)}`;
    if (border.r) css += `border-right:${getHtmlBorderStyle(border.r.style, border.r.color)}`;
    if (border.b) css += `border-bottom:${getHtmlBorderStyle(border.b.style, border.b.color)}`;
    if (border.t) css += `border-top:${getHtmlBorderStyle(border.t.style, border.t.color)}`;
    return css;
}

export function scrollToHighlightCell(ctx: Context, r: number, c: number) {
    const { scrollLeft, scrollTop } = ctx;
    const winH = ctx.cellmainHeight;
    const winW = ctx.cellmainWidth;

    const sheetIndex = getSheetIndex(ctx, ctx.currentSheetId);
    const sheet = sheetIndex == null ? null : ctx.sheets[sheetIndex];

    if (!sheet) return;

    const frozen = sheet?.frozen;

    // Accumulate both axes into one scrollRequest so a single keyboard-follow
    // produces one programmatic-scroll intent applied to the native surface.
    const request: { left?: number; top?: number } = {};

    if (r >= 0) {
        const row_focus = sheet?.frozen?.range?.row_focus || 0;
        const freezeH = frozen && r > row_focus ? ctx.visibledatarow[row_focus] : 0;
        const row = ctx.visibledatarow[r];
        const row_pre = r - 1 === -1 ? 0 : ctx.visibledatarow[r - 1];

        if (row - scrollTop - winH + 20 > 0) {
            request.top = row - winH + 20;
        } else if (row_pre - scrollTop - freezeH < 0) {
            const scrollAmount = Math.max(20, freezeH);
            request.top = row_pre - scrollAmount;
        }
    }

    if (c >= 0) {
        const column_focus = sheet?.frozen?.range?.column_focus || 0;
        const freezeW = frozen && c > column_focus ? ctx.visibledatacolumn[column_focus] : 0;
        const col = ctx.visibledatacolumn[c];
        const col_pre = c - 1 === -1 ? 0 : ctx.visibledatacolumn[c - 1];

        if (col - scrollLeft - winW + 20 > 0) {
            request.left = col - winW + 20;
        } else if (col_pre - scrollLeft - freezeW < 0) {
            const scrollAmount = Math.max(20, freezeW);
            request.left = col_pre - scrollAmount;
        }
    }

    if (request.left != null || request.top != null) {
        ctx.scrollRequest = request;
    }
}

// Formula function: selection highlight box
export function seletedHighlistByindex(ctx: Context, r1: number, r2: number, c1: number, c2: number) {
    const row = ctx.visibledatarow[r2];
    const row_pre = r1 - 1 === -1 ? 0 : ctx.visibledatarow[r1 - 1];
    const col = ctx.visibledatacolumn[c2];
    const col_pre = c1 - 1 === -1 ? 0 : ctx.visibledatacolumn[c1 - 1];

    if (isNumber(row) && isNumber(row_pre) && isNumber(col) && isNumber(col_pre)) {
        return {
            left: col_pre,
            width: col - col_pre - 1,
            top: row_pre,
            height: row - row_pre - 1,
        };
    }
    return null;
}

// Overload preserves non-undefined input on return: callers that pass a literal
// `[...]` get a non-undefined `Selection[]` back, callers that pass
// `ctx.selections` get the same `Selection[] | undefined`.
export function normalizeSelection(ctx: Context, selection: Selection[]): Selection[];
export function normalizeSelection(ctx: Context, selection: undefined): undefined;
export function normalizeSelection(ctx: Context, selection: SheetType['selections']): SheetType['selections'];
export function normalizeSelection(ctx: Context, selection: SheetType['selections']) {
    if (!selection) return selection;

    const flowdata = getFlowdata(ctx);
    if (!flowdata) return selection;

    for (let i = 0; i < selection.length; i += 1) {
        const r1 = selection[i].row[0];
        // `row`/`column` are typed `number[]`, so callers may pass a single-cell
        // `[n]`; backfill the missing end so it normalizes to a `[n, n]` range.
        const r2 = selection[i].row[1] ?? r1;
        const c1 = selection[i].column[0];
        const c2 = selection[i].column[1] ?? c1;

        let rf: number | undefined;
        let cf: number | undefined;
        if (isNil(selection[i].row_focus)) {
            rf = r1;
        } else {
            rf = selection[i].row_focus;
        }

        if (isNil(selection[i].column_focus)) {
            cf = c1;
        } else {
            cf = selection[i].column_focus;
        }

        if (isNil(rf) || isNil(cf)) {
            console.error('normalizeSelection: rf and cf is nil');
            return selection;
        }

        const row = ctx.visibledatarow[r2];
        const row_pre = r1 - 1 === -1 ? 0 : ctx.visibledatarow[r1 - 1];
        const col = ctx.visibledatacolumn[c2];
        const col_pre = c1 - 1 === -1 ? 0 : ctx.visibledatacolumn[c1 - 1];

        let row_f = ctx.visibledatarow[rf];
        let row_pre_f = rf - 1 === -1 ? 0 : ctx.visibledatarow[rf - 1];
        let col_f = ctx.visibledatacolumn[cf];
        let col_pre_f = cf - 1 === -1 ? 0 : ctx.visibledatacolumn[cf - 1];

        const margeset = mergeBorder(ctx, flowdata, rf, cf);
        if (margeset) {
            [row_pre_f, row_f] = margeset.row;
            [col_pre_f, col_f] = margeset.column;
        }

        selection[i].row = [r1, r2];
        selection[i].column = [c1, c2];

        selection[i].row_focus = rf;
        selection[i].column_focus = cf;

        selection[i].left = col_pre_f;
        selection[i].width = col_f - col_pre_f <= 0 ? 0 : col_f - col_pre_f - 1;
        selection[i].top = row_pre_f;
        selection[i].height = row_f - row_pre_f <= 0 ? 0 : row_f - row_pre_f - 1;

        selection[i].left_move = col_pre;
        selection[i].width_move = col - col_pre <= 0 ? 0 : col - col_pre - 1;
        selection[i].top_move = row_pre;
        selection[i].height_move = row - row_pre <= 0 ? 0 : row - row_pre - 1;
    }
    return selection;
}

export function selectTitlesMap(rangeMap: Record<string, number>, range1: number, range2: number) {
    const map: Record<string, number> = rangeMap || {};
    for (let i = range1; i <= range2; i += 1) {
        if (i in map) {
            continue;
        }
        map[i] = 0;
    }
    return map;
}

export function selectTitlesRange(map: Record<string, number>) {
    const mapArr = Object.keys(map).map(Number);

    mapArr.sort((a, b) => {
        return a - b;
    });

    let rangeArr: number[][] | undefined;
    let item = [];

    if (mapArr.length > 1) {
        rangeArr = [];
        for (let j = 1; j < mapArr.length; j += 1) {
            if (mapArr[j] - mapArr[j - 1] === 1) {
                item.push(mapArr[j - 1]);

                if (j === mapArr.length - 1) {
                    item.push(mapArr[j]);
                    rangeArr.push(item);
                }
            } else {
                if (j === 1) {
                    if (j === mapArr.length - 1) {
                        item.push(mapArr[j - 1]);
                        rangeArr.push(item);
                        rangeArr.push([mapArr[j]]);
                    } else {
                        rangeArr.push([mapArr[0]]);
                    }
                } else if (j === mapArr.length - 1) {
                    item.push(mapArr[j - 1]);
                    rangeArr.push(item);
                    rangeArr.push([mapArr[j]]);
                } else {
                    item.push(mapArr[j - 1]);
                    rangeArr.push(item);
                    item = [];
                }
            }
        }
    } else {
        rangeArr = [];
        rangeArr.push([mapArr[0]]);
    }

    return rangeArr;
}

export function pasteHandlerOfPaintModel(ctx: Context, copyRange: Context['copyState']) {
    const cfg = ctx.config;
    if (cfg.merge == null) {
        cfg.merge = {};
    }

    if (!copyRange) return;
    // Copy range
    const copyHasMC = copyRange.HasMC;
    const copySheetIndex = copyRange.dataSheetId;

    const c_r1 = copyRange.copyRange[0].row[0];
    const c_r2 = copyRange.copyRange[0].row[1];
    const c_c1 = copyRange.copyRange[0].column[0];
    const c_c2 = copyRange.copyRange[0].column[1];

    const copyData = cloneDeep(getdatabyselection(ctx, { row: [c_r1, c_r2], column: [c_c1, c_c2] }, copySheetIndex));

    // Apply range
    if (!ctx.selections) return;
    // Selected region
    const last = ctx.selections[ctx.selections.length - 1];
    // Selected region output
    const minh = last.row[0];
    let maxh = last.row[1]; // Apply range: first and last rows
    const minc = last.column[0];
    let maxc = last.column[1]; // Apply range: first and last columns

    const copyh = copyData.length;
    const copyc = copyData[0].length;

    if (minh === maxh && minc === maxc) {
        // Apply range is a single cell; automatically expand to the copy range size (if the expanded range partially overlaps a merged cell, show a warning)
        let has_PartMC = false;
        if (cfg.merge != null) {
            has_PartMC = hasPartMC(ctx, minh, minh + copyh - 1, minc, minc + copyc - 1);
        }

        if (has_PartMC) {
            return;
        }

        maxh = minh + copyh - 1;
        maxc = minc + copyc - 1;
    }

    const timesH = Math.ceil((maxh - minh + 1) / copyh); // Number of row copy groups
    const timesC = Math.ceil((maxc - minc + 1) / copyc); // Number of column copy groups

    const flowdata = getFlowdata(ctx); // fetch data
    if (flowdata == null) return;
    const cellMaxLength = flowdata[0].length;
    const rowMaxLength = flowdata.length;

    const borderInfoCompute = getBorderInfoCompute(ctx, copySheetIndex);
    const c_dataVerification = cloneDeep(ctx.sheets[getSheetIndex(ctx, copySheetIndex)!].dataVerification) || {};
    let dataVerification: Record<string, DataVerificationRule> | undefined;

    let mth = 0;
    let mtc = 0;
    let maxcellCahe = 0;
    let maxrowCache = 0;
    for (let th = 1; th <= timesH; th += 1) {
        for (let tc = 1; tc <= timesC; tc += 1) {
            mth = minh + (th - 1) * copyh;
            mtc = minc + (tc - 1) * copyc;

            maxrowCache = minh + th * copyh > rowMaxLength ? rowMaxLength : minh + th * copyh;
            if (maxrowCache > maxh + 1) {
                maxrowCache = maxh + 1;
            }

            maxcellCahe = minc + tc * copyc > cellMaxLength ? cellMaxLength : minc + tc * copyc;
            if (maxcellCahe > maxc + 1) {
                maxcellCahe = maxc + 1;
            }

            // Track newly emitted merge anchors keyed by the source `${r}_${c}` so a
            // copied non-anchor cell ({ mc: { r, c } } without rs/cs) can rewrite its
            // anchor reference to the cloned anchor's coordinates in the apply range.
            const offsetMC: Record<string, [number, number]> = {};
            for (let h = mth; h < maxrowCache; h += 1) {
                if (h == null) return;
                if (flowdata[h] == null) return;
                const x: (Cell | null)[] = flowdata[h];

                for (let c = mtc; c < maxcellCahe; c += 1) {
                    const computeEntry = borderInfoCompute[`${c_r1 + h - mth}_${c_c1 + c - mtc}`];
                    if (computeEntry) {
                        const bd_obj: CellBorderInfo = {
                            rangeType: 'cell',
                            value: {
                                row_index: h,
                                col_index: c,
                                l: computeEntry.l,
                                r: computeEntry.r,
                                t: computeEntry.t,
                                b: computeEntry.b,
                            },
                        };

                        if (cfg.borderInfo == null) {
                            cfg.borderInfo = [];
                        }

                        cfg.borderInfo.push(bd_obj);
                    } else if (borderInfoCompute[`${h}_${c}`]) {
                        const bd_obj: CellBorderInfo = {
                            rangeType: 'cell',
                            value: {
                                row_index: h,
                                col_index: c,
                                l: null,
                                r: null,
                                t: null,
                                b: null,
                            },
                        };

                        if (cfg.borderInfo == null) {
                            cfg.borderInfo = [];
                        }

                        cfg.borderInfo.push(bd_obj);
                    }

                    // Data validation copy
                    if (c_dataVerification[`${c_r1 + h - mth}_${c_c1 + c - mtc}`]) {
                        if (dataVerification == null) {
                            dataVerification =
                                cloneDeep(ctx.sheets[getSheetIndex(ctx, ctx.currentSheetId)!].dataVerification) ?? {};
                        }

                        dataVerification[`${h}_${c}`] = c_dataVerification[`${c_r1 + h - mth}_${c_c1 + c - mtc}`];
                    }

                    let cell = x[c];
                    if (cell?.mc) {
                        if (cell.mc.rs) {
                            delete cfg.merge[`${cell.mc.r}_${cell.mc.c}`];
                        }
                        delete cell.mc;
                    }

                    const value: Cell | null = copyData[h - mth]?.[c - mtc] ?? null;

                    if (cell != null) {
                        if (cell.ct?.t === 'inlineStr' && value) {
                            delete value.ct;
                        } else {
                            const format = [
                                'bg',
                                'fc',
                                'ct',
                                'ht',
                                'vt',
                                'bl',
                                'it',
                                'cl',
                                'un',
                                'fs',
                                'ff',
                                'tb',
                            ] as const;
                            for (const item of format) {
                                Reflect.deleteProperty(cell, item);
                            }
                        }
                    } else {
                        // Legacy: when flowdata had a raw scalar at [h][c], the original
                        // code wrapped it as `{v: scalar}`. Under the canonical CellMatrix
                        // type the cell is `null` here, so a fresh empty cell suffices.
                        cell = {};
                        x[c] = cell;
                    }

                    if (value != null) {
                        delete value.v;
                        delete value.m;
                        delete value.f;

                        if (value.ct?.t === 'inlineStr') {
                            delete value.ct;
                        }

                        Object.assign(cell, cloneDeep(value));
                        if (cell.ct?.t === 'inlineStr' && cell.ct.s) {
                            for (const item of cell.ct.s) {
                                Object.assign(item, value);
                            }
                        }

                        if (copyHasMC && cell.mc) {
                            const mc = cell.mc;
                            if (mc.rs != null) {
                                // Anchor cell of a merge — rewrite to new row/col and
                                // clamp rs/cs against the paste-area bounds.
                                mc.r = h;
                                if (mc.rs + h >= maxrowCache) {
                                    mc.rs = maxrowCache - h;
                                }

                                mc.c = c;
                                if (mc.cs != null && mc.cs + c >= maxcellCahe) {
                                    mc.cs = maxcellCahe - c;
                                }

                                cfg.merge[`${mc.r}_${mc.c}`] = {
                                    r: mc.r,
                                    c: mc.c,
                                    rs: mc.rs,
                                    cs: mc.cs ?? 1,
                                };

                                if (value.mc) {
                                    offsetMC[`${value.mc.r}_${value.mc.c}`] = [mc.r, mc.c];
                                }
                            } else if (value.mc) {
                                const anchor = offsetMC[`${value.mc.r}_${value.mc.c}`];
                                cell = { mc: { r: anchor[0], c: anchor[1] } };
                                x[c] = cell;
                            }
                        }

                        if (cell.v != null && value.ct?.fa != null) {
                            // Update the value modified by the format painter
                            cell.m = update(value.ct.fa, cell.v);
                        }
                    }
                }
                flowdata[h] = x;
            }
        }
    }

    const currFile = ctx.sheets[getSheetIndex(ctx, ctx.currentSheetId)!];
    currFile.config = cfg;
    currFile.dataVerification = dataVerification;

    const copyIndex = getSheetIndex(ctx, copySheetIndex);
    if (copyIndex == null) return;
    const ruleArr: ConditionalFormatRule[] | undefined = cloneDeep(ctx.sheets[copyIndex].conditionalFormatRules);
    if (isNil(ruleArr) || ruleArr.length === 0) return;

    const cdformat: ConditionalFormatRule[] = cloneDeep(currFile.conditionalFormatRules) ?? [];
    const copyRangeBox: SingleRange = { row: [c_r1, c_r2], column: [c_c1, c_c2] };
    const applyRangeBox: SingleRange = { row: [minh, maxh], column: [minc, maxc] };

    for (const rule of ruleArr) {
        const overlaps = rule.cellrange.some(
            (cr) => cfSplitRange(cr, copyRangeBox, applyRangeBox, 'operatePart').length > 0,
        );
        if (overlaps) {
            // Fresh per-rule box so a later mutation on one rule can't bleed into the others.
            rule.cellrange = [{ row: [...applyRangeBox.row], column: [...applyRangeBox.column] }];
            cdformat.push(rule);
        }
    }

    currFile.conditionalFormatRules = cdformat;
}

// shift + arrow key / ctrl + shift + arrow key functionality
export function rowHasMerged(ctx: Context, r: number, c1: number, c2: number) {
    let hasMerged = false;
    const flowData = getFlowdata(ctx);
    if (isNil(flowData) || isNil(flowData[r])) return false;
    for (let c = c1; c <= c2; c += 1) {
        const cell = flowData[r][c];
        if (!isNil(cell) && 'mc' in cell) {
            hasMerged = true;
            break;
        }
    }

    return hasMerged;
}

export function colHasMerged(ctx: Context, c: number, r1: number, r2: number) {
    let hasMerged = false;
    const flowData = getFlowdata(ctx);
    if (isNil(flowData)) return false;
    for (let r = r1; r <= r2; r += 1) {
        const cell = flowData[r]?.[c];
        if (!isNil(ctx.config.merge) && !isNil(cell) && 'mc' in cell && !isNil(cell.mc)) {
            hasMerged = true;
            break;
        }
    }
    return hasMerged;
}

// Get merged cell info
export function getRowMerge(ctx: Context, rIndex: number, c1: number, c2: number) {
    const flowData = getFlowdata(ctx);
    if (isNil(flowData)) return [null, null];
    const r2 = flowData.length - 1;
    let str = null;
    if (rIndex > 0) {
        for (let r = rIndex; r >= 0; r -= 1) {
            for (let c = c1; c <= c2; c += 1) {
                const cell = flowData[r][c];
                if (!isNil(cell) && !isNil(cell.mc) && 'mc' in cell && !isNil(ctx.config.merge)) {
                    const mc = ctx.config.merge[`${cell.mc.r}_${cell.mc.c}`];
                    if (isNil(str) || mc.r < str) {
                        str = mc.r;
                    }
                }
            }
            if (!isNil(str) && rowHasMerged(ctx, str - 1, c1, c2) && str > 0) {
                r = str;
            } else {
                break;
            }
        }
    } else {
        str = 0;
    }
    let end = null;
    if (rIndex < r2) {
        for (let r = rIndex; r <= r2; r += 1) {
            for (let c = c1; c <= c2; c += 1) {
                const cell = flowData[r][c];
                if (!isNil(cell) && !isNil(cell.mc) && 'mc' in cell && !isNil(ctx.config.merge)) {
                    const mc = ctx.config.merge[`${cell.mc.r}_${cell.mc.c}`];
                    if (isNil(end) || mc.r + mc.rs - 1 > end) {
                        end = mc.r + mc.rs - 1;
                    }
                }
            }
            if (!isNil(end) && rowHasMerged(ctx, end + 1, c1, c2) && end < r2) {
                r = end;
            } else {
                break;
            }
        }
    } else {
        end = r2;
    }
    return [str, end];
}

export function getColMerge(ctx: Context, cIndex: number, r1: number, r2: number) {
    const flowData = getFlowdata(ctx);
    if (isNil(flowData)) {
        return [null, null];
    }
    const c2 = flowData[0].length - 1;
    let str = null;
    if (cIndex > 0) {
        for (let c = cIndex; c >= 0; c -= 1) {
            for (let r = r1; r <= r2; r += 1) {
                const cell = flowData[r][c];
                if (!isNil(ctx.config.merge) && !isNil(cell) && 'mc' in cell && !isNil(cell.mc)) {
                    const mc = ctx.config.merge[`${cell.mc.r}_${cell.mc.c}`];
                    if (isNil(str) || mc.c < str) {
                        str = mc.c;
                    }
                }
            }
            if (!isNil(str) && colHasMerged(ctx, str - 1, r1, r2) && str > 0) {
                c = str;
            } else {
                break;
            }
        }
    } else {
        str = 0;
    }
    let end = null;
    if (cIndex < c2) {
        for (let c = cIndex; c <= c2; c += 1) {
            for (let r = r1; r <= r2; r += 1) {
                const cell = flowData[r][c];
                if (!isNil(ctx.config.merge) && !isNil(cell) && 'mc' in cell && !isNil(cell.mc)) {
                    const mc = ctx.config.merge[`${cell.mc.r}_${cell.mc.c}`];
                    if (isNil(end) || mc.c + mc.cs - 1 > end) {
                        end = mc.c + mc.cs - 1;
                    }
                }
            }

            if (!isNil(end) && colHasMerged(ctx, end + 1, r1, r2) && end < c2) {
                c = end;
            } else {
                break;
            }
        }
    } else {
        end = c2;
    }
    return [str, end];
}

// Merge-aware walk shared by both moveHighlightCell targets. Advances the focused
// cell by `index` along `postion`, resolving merged-cell spans on both the source
// and the destination. All fields are pixel/index coordinates, populated from a
// mergeBorder() tuple or from visibledata{row,column} lookups; returns null on the
// shared nil failure (same console message both callers logged). The one true
// difference between the targets: when the destination is NOT a merged cell, the
// selection target keys the new range off the clamped cursor (curR/curC) while the
// formula target keys it off the moved anchor (moveX/moveY) — `indexFromMove`.
type HighlightCellWalk = {
    row: number | undefined;
    row_pre: number | undefined;
    row_index: number | undefined;
    row_index_ed: number | undefined;
    col: number | undefined;
    col_pre: number | undefined;
    col_index: number | undefined;
    col_index_ed: number | undefined;
    moveX: number;
    moveY: number;
};

function computeMoveHighlightCell(
    ctx: Context,
    flowdata: NonNullable<ReturnType<typeof getFlowdata>>,
    last: Selection,
    postion: 'down' | 'right',
    index: number,
    indexFromMove: boolean,
): HighlightCellWalk | null {
    const datarowlen = flowdata.length;
    const datacolumnlen = flowdata[0].length;

    let curR: number;
    if (isNil(last.row_focus)) {
        [curR] = last.row;
    } else {
        curR = last.row_focus;
    }

    let curC: number;
    if (isNil(last.column_focus)) {
        [curC] = last.column;
    } else {
        curC = last.column_focus;
    }

    // Whether the focused cell is a merged cell
    const margeset = mergeBorder(ctx, flowdata, curR, curC);
    if (margeset) {
        const str_r = margeset.row[2];
        const end_r = margeset.row[3];

        const str_c = margeset.column[2];
        const end_c = margeset.column[3];

        if (index > 0) {
            if (postion === 'down') {
                curR = end_r;
                curC = str_c;
            } else if (postion === 'right') {
                curR = str_r;
                curC = end_c;
            }
        } else {
            curR = str_r;
            curC = str_c;
        }
    }

    if (isNil(curR) || isNil(curC)) {
        console.error('moveHighlightCell: curR or curC is nil');
        return null;
    }

    let moveX = isNil(last.moveXY) ? curR : last.moveXY.x;
    let moveY = isNil(last.moveXY) ? curC : last.moveXY.y;

    if (postion === 'down') {
        curR += index;
        moveX = curR;
    } else if (postion === 'right') {
        curC += index;
        moveY = curC;
    }

    if (curR >= datarowlen) {
        curR = datarowlen - 1;
        moveX = curR;
    }

    if (curR < 0) {
        curR = 0;
        moveX = curR;
    }

    if (curC >= datacolumnlen) {
        curC = datacolumnlen - 1;
        moveY = curC;
    }

    if (curC < 0) {
        curC = 0;
        moveY = curC;
    }

    // Whether the next cell to move to is a merged cell
    const margeset2 = mergeBorder(ctx, flowdata, curR, curC);
    if (margeset2) {
        const [row_pre, row, row_index, row_index_ed] = margeset2.row;
        const [col_pre, col, col_index, col_index_ed] = margeset2.column;
        return { row, row_pre, row_index, row_index_ed, col, col_pre, col_index, col_index_ed, moveX, moveY };
    }

    const row = ctx.visibledatarow[moveX];
    const row_pre = moveX - 1 === -1 ? 0 : ctx.visibledatarow[moveX - 1];
    const col = ctx.visibledatacolumn[moveY];
    const col_pre = moveY - 1 === -1 ? 0 : ctx.visibledatacolumn[moveY - 1];
    const anchorR = indexFromMove ? moveX : curR;
    const anchorC = indexFromMove ? moveY : curC;

    return {
        row,
        row_pre,
        row_index: anchorR,
        row_index_ed: anchorR,
        col,
        col_pre,
        col_index: anchorC,
        col_index_ed: anchorC,
        moveX,
        moveY,
    };
}

export function moveHighlightCell(
    ctx: Context,
    postion: 'down' | 'right',
    index: number,
    type: 'rangeOfSelect' | 'rangeOfFormula',
) {
    const flowdata = getFlowdata(ctx);
    if (!flowdata) return;

    if (type === 'rangeOfSelect') {
        const last = ctx.selections?.[ctx.selections.length - 1];
        if (!last) {
            console.error('moveHighlightCell: no selection found');
            return;
        }

        const walk = computeMoveHighlightCell(ctx, flowdata, last, postion, index, false);
        if (!walk) return;
        const { row_index, row_index_ed, col_index, col_index_ed, moveX, moveY } = walk;

        if (isNil(row_index) || isNil(row_index_ed) || isNil(col_index) || isNil(col_index_ed)) {
            console.error('moveHighlightCell: row_index or row_index_ed or col_index or col_index_ed is nil');
            return;
        }

        last.row = [row_index, row_index_ed];
        last.column = [col_index, col_index_ed];
        last.row_focus = row_index;
        last.column_focus = col_index;
        last.moveXY = { x: moveX, y: moveY };

        normalizeSelection(ctx, ctx.selections);
        scrollToHighlightCell(ctx, row_index, col_index);
    } else if (type === 'rangeOfFormula') {
        const last = ctx.formulaCache.func_selectedrange;
        if (!last) return;

        const walk = computeMoveHighlightCell(ctx, flowdata, last, postion, index, true);
        if (!walk) return;
        const { row, row_pre, row_index, row_index_ed, col, col_pre, col_index, col_index_ed, moveX, moveY } = walk;

        if (
            isNil(col) ||
            isNil(col_pre) ||
            isNil(row) ||
            isNil(row_pre) ||
            isNil(row_index) ||
            isNil(row_index_ed) ||
            isNil(col_index) ||
            isNil(col_index_ed)
        ) {
            console.error('moveHighlightCell: some values of func_selectedrange is nil');
            return;
        }

        ctx.formulaCache.func_selectedrange = {
            left: col_pre,
            width: col - col_pre - 1,
            top: row_pre,
            height: row - row_pre - 1,
            left_move: col_pre,
            width_move: col - col_pre - 1,
            top_move: row_pre,
            height_move: row - row_pre - 1,
            row: [row_index, row_index_ed],
            column: [col_index, col_index_ed],
            row_focus: row_index,
            column_focus: col_index,
            moveXY: { x: moveX, y: moveY },
        };
    }
}

// shift + arrow key: adjust the selection range
//
// NOTE (C4): the two targets below look like clones but are NOT — do not
// "de-duplicate" them. The formula arm diverges from the selection arm inside
// several merge branches, preserved verbatim from luckysheet:
//   - down / merged, `rf_end < endR` branch: the selection arm reads
//     getRowMerge(ctx, curR, …) and applies `endR += index` outside the guard;
//     the formula arm reads getRowMerge(ctx, endR, …) and applies it inside.
//   - right / first branch (both merged and non-merged): the selection arm adds
//     `curC += index` twice (inside + outside the inner guard); the formula arm
//     adds it once.
//   - the selection arm returns early when rf/cf are nil and then compares them
//     directly; the formula arm guards every rf/cf use with !isNil instead.
//   - the write-backs differ (in-place selection mutate + normalize + scroll vs.
//     rebuilding func_selectedrange with fresh geometry).
// Unifying would change behavior. The shared clamp/geometry tail is left inline
// so these divergences stay visible side by side.
export function moveHighlightRange(
    ctx: Context,
    postion: 'down' | 'right',
    index: number,
    type: 'rangeOfSelect' | 'rangeOfFormula',
) {
    // Pixel-coordinate edges of the resulting selection rectangle, assigned
    // inside the branch that matches `type` and then read once for display.
    let row: number;
    let row_pre: number;
    let col: number;
    let col_pre: number;
    const flowData = getFlowdata(ctx);
    if (isNil(flowData)) return;
    if (isNil(ctx.selections)) return;
    if (type === 'rangeOfSelect') {
        const last = ctx.selections[ctx.selections.length - 1];
        let curR = last.row[0];
        let endR = last.row[1];
        let curC = last.column[0];
        let endC = last.column[1];
        const rf = last.row_focus;
        const cf = last.column_focus;
        if (isNil(rf) || isNil(cf)) return;
        const datarowlen = flowData.length;
        const datacolumnlen = flowData[0].length;
        if (postion === 'down') {
            // Selection changes vertically
            if (rowHasMerged(ctx, rf, curC, endC)) {
                // The row containing the focused cell has merged cells
                const rfMerge = getRowMerge(ctx, rf, curC, endC);
                const rf_str = rfMerge[0];
                const rf_end = rfMerge[1];
                if (!isNil(rf_str) && rf_str > curR && rf_end === endR) {
                    if (index > 0 && rowHasMerged(ctx, curR, curC, endC)) {
                        const v = getRowMerge(ctx, curR, curC, endC)[1];
                        if (!isNil(v)) {
                            curR = v;
                        }
                    }
                    curR += index;
                } else if (!isNil(rf_end) && rf_end < endR && rf_str === curR) {
                    if (index < 0 && rowHasMerged(ctx, endR, curC, endC)) {
                        const v = getRowMerge(ctx, curR, curC, endC)[0];
                        if (!isNil(v)) {
                            endR = v;
                        }
                    }
                    endR += index;
                } else {
                    if (index > 0) {
                        endR += index;
                    } else {
                        curR += index;
                    }
                }
            } else {
                if (rf > curR && rf === endR) {
                    if (index > 0 && rowHasMerged(ctx, curR, curC, endC)) {
                        const v = getRowMerge(ctx, curR, curC, endC)[1];
                        if (!isNil(v)) {
                            curR = v;
                        }
                    }
                    curR += index;
                } else if (rf < endR && rf === curR) {
                    if (index < 0 && rowHasMerged(ctx, endR, curC, endC)) {
                        const v = getRowMerge(ctx, endR, curC, endC)[0];
                        if (!isNil(v)) {
                            endR = v;
                        }
                    }
                    endR += index;
                } else if (rf === curR && rf === endR) {
                    if (index > 0) {
                        endR += index;
                    } else {
                        curR += index;
                    }
                }
            }
            if (endR >= datarowlen) {
                endR = datarowlen - 1;
            }
            if (endR < 0) {
                endR = 0;
            }
            if (curR >= datarowlen) {
                curR = datarowlen - 1;
            }
            if (curR < 0) {
                curR = 0;
            }
        } else {
            if (colHasMerged(ctx, cf, curR, endR)) {
                const cfMerge = getColMerge(ctx, cf, curR, endR);
                const cf_str = cfMerge[0];
                const cf_end = cfMerge[1];
                if (!isNil(cf_str) && cf_str > curC && cf_end === endC) {
                    if (index > 0 && colHasMerged(ctx, curC, curR, endR)) {
                        const v = getColMerge(ctx, curC, curR, endR)[1];
                        if (!isNil(v)) {
                            curC = v;
                        }
                        curC += index;
                    }
                    curC += index;
                } else if (!isNil(cf_end) && cf_end < endC && cf_str === curC) {
                    if (index < 0 && colHasMerged(ctx, endC, curR, endR)) {
                        const v = getColMerge(ctx, endC, curR, endR)[0];
                        if (!isNil(v)) {
                            endC = v;
                        }
                    }
                    endC += index;
                } else {
                    if (index > 0) {
                        endC += index;
                    } else {
                        curC += index;
                    }
                }
            } else {
                if (cf > curC && cf === endC) {
                    if (index > 0 && colHasMerged(ctx, curC, curR, endR)) {
                        const v = getColMerge(ctx, curC, curR, endR)[1];
                        if (!isNil(v)) {
                            curC = v;
                        }
                        curC += index;
                    }
                    curC += index;
                } else if (cf < endC && cf === curC) {
                    if (index < 0 && colHasMerged(ctx, endC, curR, endR)) {
                        const v = getColMerge(ctx, endC, curR, endR)[0];
                        if (!isNil(v)) {
                            endC = v;
                        }
                    }
                    endC += index;
                } else if (cf === curC && cf === endC) {
                    if (index > 0) {
                        endC += index;
                    } else {
                        curC += index;
                    }
                }
            }
            if (endC >= datacolumnlen) {
                endC = datacolumnlen - 1;
            }
            if (endC < 0) {
                endC = 0;
            }
            if (curC >= datacolumnlen) {
                curC = datacolumnlen - 1;
            }
            if (curC < 0) {
                curC = 0;
            }
        }
        let rowseleted: number[] = [curR, endR];
        let columnseleted: number[] = [curC, endC];
        row = ctx.visibledatarow[endR];
        row_pre = curR - 1 === -1 ? 0 : ctx.visibledatarow[curR - 1];
        col = ctx.visibledatacolumn[endC];
        col_pre = curC - 1 === -1 ? 0 : ctx.visibledatacolumn[curC - 1];
        const changeparam = mergeMoveMain(
            ctx,
            columnseleted,
            rowseleted,
            last,
            row_pre,
            row - row_pre - 1,
            col_pre,
            col - col_pre - 1,
        );
        if (!isNil(changeparam)) {
            [columnseleted, rowseleted] = changeparam;
        }
        last.row = rowseleted;
        last.column = columnseleted;
        normalizeSelection(ctx, ctx.selections);

        if (postion === 'down') {
            const rowToScroll = last.row_focus === last.row[0] ? last.row[1] : last.row[0];
            scrollToHighlightCell(ctx, rowToScroll, -1);
        } else {
            const columnToScroll = last.column_focus === last.column[0] ? last.column[1] : last.column[0];
            scrollToHighlightCell(ctx, -1, columnToScroll);
        }
    } else if (type === 'rangeOfFormula') {
        const last = ctx.formulaCache.func_selectedrange;
        if (isNil(last)) return;
        let curR = last.row[0];
        let endR = last.row[1];
        let curC = last.column[0];
        let endC = last.column[1];
        const rf = last.row_focus;
        const cf = last.column_focus;

        const datarowlen = flowData.length;
        const datacolumnlen = flowData[0].length;

        if (postion === 'down') {
            if (!isNil(rf) && rowHasMerged(ctx, rf, curC, endC)) {
                const rfMerge = getRowMerge(ctx, rf, curC, endC);
                const rf_str = rfMerge[0];
                const rf_end = rfMerge[1];
                if (!isNil(rf_str) && rf_str > curR && rf_end === endR) {
                    if (index > 0 && rowHasMerged(ctx, curR, curC, endC)) {
                        const v = getRowMerge(ctx, curR, curC, endC)[1];
                        if (!isNil(v)) {
                            curR = v;
                        }
                    }
                    curR += index;
                } else if (!isNil(rf_end) && rf_end < endR && rf_str === curR) {
                    if (index < 0 && rowHasMerged(ctx, endR, curC, endC)) {
                        const v = getRowMerge(ctx, endR, curC, endC)[0];
                        if (!isNil(v)) {
                            endR = v;
                        }
                        endR += index;
                    }
                } else {
                    if (index > 0) {
                        endR += index;
                    } else {
                        curR += index;
                    }
                }
            } else {
                if (!isNil(rf) && rf > curR && rf === endR) {
                    if (index > 0 && rowHasMerged(ctx, curR, curC, endC)) {
                        const v = getRowMerge(ctx, curR, curC, endC)[1];
                        if (!isNil(v)) {
                            curR = v;
                        }
                    }
                    curR += index;
                } else if (!isNil(rf) && rf < endR && rf === curR) {
                    if (index < 0 && rowHasMerged(ctx, endR, curC, endC)) {
                        const v = getRowMerge(ctx, endR, curC, endC)[0];
                        if (!isNil(v)) {
                            endR = v;
                        }
                    }
                    endR += index;
                } else if (rf === curR && rf === endR) {
                    if (index > 0) {
                        endR += index;
                    } else {
                        curR += index;
                    }
                }
            }
            if (endR >= datarowlen) {
                endR = datarowlen - 1;
            }
            if (endR < 0) {
                endR = 0;
            }
            if (curR >= datarowlen) {
                curR = datarowlen - 1;
            }
            if (curR < 0) {
                curR = 0;
            }
        } else {
            if (!isNil(cf) && colHasMerged(ctx, cf, curR, endR)) {
                const cfMerge = getColMerge(ctx, cf, curR, endR);
                const cf_str = cfMerge[0];
                const cf_end = cfMerge[1];
                if (!isNil(cf_str) && cf_str > curC && cf_end === endC) {
                    if (index > 0 && colHasMerged(ctx, curC, curR, endR)) {
                        const v = getColMerge(ctx, curC, curR, endR)[1];
                        if (!isNil(v)) {
                            curC = v;
                        }
                    }

                    curC += index;
                } else if (!isNil(cf_end) && cf_end < endC && cf_str === curC) {
                    if (index < 0 && colHasMerged(ctx, endC, curR, endR)) {
                        const v = getColMerge(ctx, endC, curR, endR)[0];
                        if (!isNil(v)) {
                            endC = v;
                        }
                    }

                    endC += index;
                } else {
                    if (index > 0) {
                        endC += index;
                    } else {
                        curC += index;
                    }
                }
            } else {
                if (!isNil(cf) && cf > curC && cf === endC) {
                    if (index > 0 && colHasMerged(ctx, curC, curR, endR)) {
                        const v = getColMerge(ctx, curC, curR, endR)[1];
                        if (!isNil(v)) {
                            curC = v;
                        }
                    }

                    curC += index;
                } else if (!isNil(cf) && cf < endC && cf === curC) {
                    if (index < 0 && colHasMerged(ctx, endC, curR, endR)) {
                        const v = getColMerge(ctx, endC, curR, endR)[0];
                        if (!isNil(v)) {
                            endC = v;
                        }
                    }

                    endC += index;
                } else if (cf === curC && cf === endC) {
                    if (index > 0) {
                        endC += index;
                    } else {
                        curC += index;
                    }
                }
            }
            if (endC >= datacolumnlen) {
                endC = datacolumnlen - 1;
            }
            if (endC < 0) {
                endC = 0;
            }
            if (curC >= datacolumnlen) {
                curC = datacolumnlen - 1;
            }
            if (curC < 0) {
                curC = 0;
            }
        }
        let rowseleted = [curR, endR];
        let columnseleted = [curC, endC];

        row = ctx.visibledatarow[endR];
        row_pre = curR - 1 === -1 ? 0 : ctx.visibledatarow[curR - 1];
        col = ctx.visibledatacolumn[endC];
        col_pre = curC - 1 === -1 ? 0 : ctx.visibledatacolumn[curC - 1];

        let top = row_pre;
        let height = row - row_pre - 1;
        let left = col_pre;
        let width = col - col_pre - 1;

        const changeparam = mergeMoveMain(ctx, columnseleted, rowseleted, last, top, height, left, width);
        if (!isNil(changeparam)) {
            [columnseleted, rowseleted, top, height, left, width] = changeparam;
        }
        ctx.formulaCache.func_selectedrange = {
            left,
            width,
            top,
            height,
            left_move: left,
            width_move: width,
            top_move: top,
            height_move: height,
            row: rowseleted,
            column: columnseleted,
            row_focus: rf,
            column_focus: cf,
        };
    }
}

function getHtmlBorderStyle(type: string | number, color: string) {
    let style = '';
    type = BORDER_STYLE_NAMES[type.toString()];

    if (type.indexOf('Medium') > -1) {
        style += '1pt ';
    } else if (type === 'Thick') {
        style += '1.5pt ';
    } else {
        style += '0.5pt ';
    }

    if (type === 'Hair') {
        style += 'double ';
    } else if (type.indexOf('DashDotDot') > -1) {
        style += 'dotted ';
    } else if (type.indexOf('DashDot') > -1) {
        style += 'dashed ';
    } else if (type.indexOf('Dotted') > -1) {
        style += 'dotted ';
    } else if (type.indexOf('Dashed') > -1) {
        style += 'dashed ';
    } else {
        style += 'solid ';
    }

    return `${style + color};`;
}

// The marker that says "this clipboard HTML came from a sheet": written by the copy path,
// matched by every paste reader.
export const COPY_ACTION_TABLE_MARKER = 'sheet-copy-action-table';

export function rangeValueToHtml(ctx: Context, sheetId: string, ranges?: Range) {
    const idx = getSheetIndex(ctx, sheetId);
    if (idx == null) return '';
    const sheet = ctx.sheets[idx];

    const rowIndexArr: number[] = [];
    const colIndexArr: number[] = [];
    // Set-based dedupe: includes() per cell turns large copies quadratic.
    const rowIndexSet = new Set<number>();
    const colIndexSet = new Set<number>();

    for (let s = 0; s < (ranges?.length ?? 0); s += 1) {
        const range = ranges![s];

        const r1 = range.row[0];
        const r2 = range.row[1];
        const c1 = range.column[0];
        const c2 = range.column[1];

        for (let copyR = r1; copyR <= r2; copyR += 1) {
            if (!rowIndexSet.has(copyR)) {
                rowIndexSet.add(copyR);
                rowIndexArr.push(copyR);
            }

            for (let copyC = c1; copyC <= c2; copyC += 1) {
                if (!colIndexSet.has(copyC)) {
                    colIndexSet.add(copyC);
                    colIndexArr.push(copyC);
                }
            }
        }
    }

    let borderInfoCompute: ReturnType<typeof getBorderInfoCompute> | undefined;
    if (sheet.config?.borderInfo && sheet.config.borderInfo.length > 0) {
        borderInfoCompute = getBorderInfoCompute(ctx, sheetId);
    }

    let cpdata = '';
    const d = sheet.data;
    if (!d) return null;

    // Precompute conditional formatting map once for the entire copy operation
    const cfCompute = getComputeMap(ctx);

    let colgroup = '';

    for (let i = 0; i < rowIndexArr.length; i += 1) {
        const r = rowIndexArr[i];

        cpdata += '<tr>';

        for (let j = 0; j < colIndexArr.length; j += 1) {
            const c = colIndexArr[j];

            // Placeholder string consumed by replaceHtml() below; `${span}` /
            // `${style}` are intentionally substituted at runtime, not by the
            // template-literal evaluator.
            // biome-ignore lint/suspicious/noTemplateCurlyInString: replaceHtml template
            let column = '<td ${span} style="${style}">';

            const cell = d[r]?.[c];
            if (cell != null) {
                let style = '';
                let span = '';

                if (r === rowIndexArr[0]) {
                    if (
                        isNil(sheet.config) ||
                        isNil(sheet.config.columnlen) ||
                        isNil(sheet.config.columnlen[c.toString()])
                    ) {
                        colgroup += '<colgroup width="72px"></colgroup>';
                    } else {
                        colgroup += `<colgroup width="${sheet.config.columnlen[c.toString()]}px"></colgroup>`;
                    }
                }

                if (c === colIndexArr[0]) {
                    if (isNil(sheet.config) || isNil(sheet.config.rowlen) || isNil(sheet.config.rowlen[r.toString()])) {
                        style += 'height:19px;';
                    } else {
                        style += `height:${sheet.config.rowlen[r.toString()]}px;`;
                    }
                }

                const reg = /^(w|W)((0?)|(0\.0+))$/;
                // getCellValue returns `cell.v` (string | number | boolean) when the
                // format ID matches the `w` width pattern, otherwise the rendered
                // `cell.m` mask string. Either way the HTML output coerces to string.
                let c_value: string | number | boolean | null | undefined;
                if (!isNil(cell.ct) && !isNil(cell.ct.fa) && cell.ct.fa.match(reg)) {
                    c_value = getCellValue(r, c, d);
                } else {
                    c_value = getCellValue(r, c, d, 'm');
                }

                // Same escaping as the rich-text runs in modules/cell.ts: the values come
                // from the cell and this lands inside a `style="..."` attribute, which the
                // HTML parser decodes before CSS sees it.
                style += escapeHtml(styleObjectToCss(getStyleByCell(ctx, d, r, c, cfCompute)));

                if (cell.mc) {
                    if ('rs' in cell.mc) {
                        span = `rowspan="${cell.mc.rs}" colspan="${cell.mc.cs}"`;

                        // Border
                        if (borderInfoCompute?.[`${r}_${c}`]) {
                            // Per-side histograms: count how many cells along the merged
                            // edge share each border color / line-style. The winning side
                            // (>= half the edge length) drives the merged cell's HTML
                            // border below.
                            const bl_obj: BorderEdgeHistogram = { color: {}, style: {} };
                            const br_obj: BorderEdgeHistogram = { color: {}, style: {} };
                            const bt_obj: BorderEdgeHistogram = { color: {}, style: {} };
                            const bb_obj: BorderEdgeHistogram = { color: {}, style: {} };

                            for (let bd_r = r; bd_r < r + cell.mc.rs!; bd_r += 1) {
                                for (let bd_c = c; bd_c < c + cell.mc.cs!; bd_c += 1) {
                                    const cellBorder = borderInfoCompute[`${bd_r}_${bd_c}`];
                                    if (!cellBorder) continue;

                                    if (bd_r === r && cellBorder.t) {
                                        bumpHistogram(bt_obj, cellBorder.t);
                                    }
                                    if (bd_r === r + cell.mc.rs! - 1 && cellBorder.b) {
                                        bumpHistogram(bb_obj, cellBorder.b);
                                    }
                                    if (bd_c === c && cellBorder.l) {
                                        bumpHistogram(bl_obj, cellBorder.l);
                                    }
                                    if (bd_c === c + cell.mc.cs! - 1 && cellBorder.r) {
                                        bumpHistogram(br_obj, cellBorder.r);
                                    }
                                }
                            }

                            const rowlen = cell.mc.rs!;
                            const collen = cell.mc.cs!;

                            style += dominantBorderSideCss(bl_obj, rowlen, 'left');
                            style += dominantBorderSideCss(br_obj, rowlen, 'right');
                            style += dominantBorderSideCss(bt_obj, collen, 'top');
                            style += dominantBorderSideCss(bb_obj, collen, 'bottom');
                        }
                    } else {
                        continue;
                    }
                } else {
                    const cellBorder = borderInfoCompute?.[`${r}_${c}`];
                    if (cellBorder) {
                        style += cellBorderCss(cellBorder);
                    }
                }

                column = replaceHtml(column, { style, span });

                if (isNil(c_value)) {
                    c_value = getCellValue(r, c, d);
                }

                if (isNil(c_value)) {
                    c_value = '';
                }

                column += escapeHtml(String(c_value));
            } else {
                let style = '';

                const cellBorder = borderInfoCompute?.[`${r}_${c}`];
                if (cellBorder) {
                    style += cellBorderCss(cellBorder);
                }

                column += '';

                if (r === rowIndexArr[0]) {
                    if (
                        isNil(sheet.config) ||
                        isNil(sheet.config.columnlen) ||
                        isNil(sheet.config.columnlen[c.toString()])
                    ) {
                        colgroup += '<colgroup width="72px"></colgroup>';
                    } else {
                        colgroup += `<colgroup width="${sheet.config.columnlen[c.toString()]}px"></colgroup>`;
                    }
                }

                if (c === colIndexArr[0]) {
                    if (isNil(sheet.config) || isNil(sheet.config.rowlen) || isNil(sheet.config.rowlen[r.toString()])) {
                        style += 'height:19px;';
                    } else {
                        style += `height:${sheet.config.rowlen[r.toString()]}px;`;
                    }
                }

                column = replaceHtml(column, { style, span: '' });
                column += '';
            }

            column += '</td>';
            cpdata += column;
        }

        cpdata += '</tr>';
    }

    return `<table data-type="${COPY_ACTION_TABLE_MARKER}">${colgroup}${cpdata}</table>`;
}

export function copy(ctx: Context) {
    const flowdata = getFlowdata(ctx);

    ctx.formulaRangeSelections = [];
    // Copy range
    const copyRange = [];
    let RowlChange = false;
    let HasMC = false;

    for (let s = 0; s < (ctx.selections?.length ?? 0); s += 1) {
        const range = ctx.selections![s];

        const r1 = range.row[0];
        const r2 = range.row[1];
        const c1 = range.column[0];
        const c2 = range.column[1];

        for (let copyR = r1; copyR <= r2; copyR += 1) {
            if (!isNil(ctx.config.rowhidden) && !isNil(ctx.config.rowhidden[copyR])) {
                continue;
            }

            if (!isNil(ctx.config.rowlen) && copyR in ctx.config.rowlen) {
                RowlChange = true;
            }

            for (let copyC = c1; copyC <= c2; copyC += 1) {
                if (!isNil(ctx.config.colhidden) && !isNil(ctx.config.colhidden[copyC])) {
                    continue;
                }

                const cell = flowdata?.[copyR]?.[copyC];

                if (!isNil(cell?.mc?.rs)) {
                    HasMC = true;
                }
            }
        }

        ctx.formulaRangeSelections.push({
            row: range.row,
            column: range.column,
        });
        copyRange.push({ row: range.row, column: range.column });
    }

    // Save copy data within luckysheet
    ctx.copyState = {
        dataSheetId: ctx.currentSheetId,
        copyRange,
        RowlChange,
        HasMC,
    };

    const cpdata = rangeValueToHtml(ctx, ctx.currentSheetId, ctx.selections);

    if (cpdata) {
        ctx.iscopyself = true;
        setPendingCopy(cpdata);
    }
}

export function deleteSelectedCellText(ctx: Context): string {
    // Record the cells we actually clear so the formula refresh recomputes only
    // those, not every cell in the selection (which is the whole matrix for
    // select-all). Reset up front so an aborted delete never leaves a stale set.
    const changed: CalcChainEntry[] = [];
    ctx.formulaCache.pendingChangedCells = changed;

    const allowEdit = isAllowEdit(ctx);
    if (allowEdit === false) {
        return 'allowEdit';
    }

    const selection = ctx.selections;
    if (selection && !isEmpty(selection)) {
        const d = getFlowdata(ctx);
        if (!d) return 'dataNullError';

        let has_PartMC = false;

        for (let s = 0; s < selection.length; s += 1) {
            const r1 = selection[s].row[0];
            const r2 = selection[s].row[1];
            const c1 = selection[s].column[0];
            const c2 = selection[s].column[1];

            if (hasPartMC(ctx, r1, r2, c1, c2)) {
                has_PartMC = true;
                break;
            }
        }
        if (has_PartMC) {
            return 'partMC';
        }

        const hyperlinkMap = ctx.sheets[getSheetIndex(ctx, ctx.currentSheetId)!].hyperlink;

        for (let s = 0; s < selection.length; s += 1) {
            const r1 = selection[s].row[0];
            const r2 = selection[s].row[1];
            const c1 = selection[s].column[0];
            const c2 = selection[s].column[1];
            const sheetIndex = getSheetIndex(ctx, ctx.currentSheetId);
            if (sheetIndex !== null && ctx.sheets[sheetIndex].data) {
                const { data = [] } = ctx.sheets[sheetIndex] ?? {};

                for (let r = r1; r <= r2; r += 1) {
                    for (let c = c1; c <= c2; c += 1) {
                        // Ensure the row exists
                        if (!data[r]) data[r] = [];

                        // Replace the entire cell with an empty object
                        if (data[r]?.[c]) {
                            changed.push({ r, c, id: ctx.currentSheetId });
                            data[r][c] = {}; // Fully replace cell with empty object
                        }

                        if (hyperlinkMap?.[`${r}_${c}`]) {
                            delete hyperlinkMap[`${r}_${c}`];
                        }
                    }
                }
            }
        }
    }
    return 'success';
}

// Whether selections overlap. Accepts the editor `Selection[]` (default) or a
// `Range` (SingleRange[]); both share the `{row, column}` rectangle the test
// needs.
export function selectIsOverlap(ctx: Context, range?: Range | SheetType['selections']) {
    const ranges = cloneDeep(range ?? ctx.selections) ?? [];

    let overlap = false;
    const seen: Record<string, true> = {};

    for (let s = 0; s < ranges.length; s += 1) {
        const str_r = ranges[s].row[0];
        const end_r = ranges[s].row[1];
        const str_c = ranges[s].column[0];
        const end_c = ranges[s].column[1];

        for (let r = str_r; r <= end_r; r += 1) {
            for (let c = str_c; c <= end_c; c += 1) {
                if (`${r}_${c}` in seen) {
                    overlap = true;
                    break;
                }
                seen[`${r}_${c}`] = true;
            }
        }
    }

    return overlap;
}

export function selectAll(ctx: Context) {
    const flowdata = getFlowdata(ctx);
    if (!flowdata) return;

    ctx.selectionActive = false;

    ctx.selections = [
        {
            row: [0, flowdata.length - 1],
            column: [0, flowdata[0].length - 1],
            row_focus: 0,
            column_focus: 0,
            row_select: true,
            column_select: true,
        },
    ];

    normalizeSelection(ctx, ctx.selections);
}

export function calcSelectionInfo(ctx: Context) {
    const selection = ctx.selections!;
    let numberC = 0;
    let count = 0;
    let sum = 0;
    let max = -Infinity;
    let min = Infinity;
    for (let s = 0; s < selection.length; s += 1) {
        const data = getDataBySelectionNoCopy(ctx, selection[s]);
        for (let r = 0; r < data.length; r += 1) {
            for (let c = 0; c < data[0].length; c += 1) {
                // Prevent the selection length from exceeding data bounds
                if (r >= data.length || c >= data[0].length) break;
                const cell = data![r][c];
                const ct = cell?.ct?.t as string;
                const value = cell?.m as string;
                // Numeric cells keep the raw number in v; m is the formatted display
                // string (currency symbols, separators) that parseFloat cannot read.
                // A nil v (empty cell formatted as numeric) must not become Number(null) = 0
                const valueNumber = ct === 'n' ? Number(cell?.v ?? Number.NaN) : parseFloat(value);
                if ((ct === 'n' || ct === 'g') && !Number.isNaN(valueNumber)) {
                    count += 1;
                    sum += valueNumber;
                    max = Math.max(valueNumber, max);
                    min = Math.min(valueNumber, min);
                    numberC += 1;
                } else if (value != null) {
                    count += 1;
                }
            }
        }
    }
    const average: string = format('0.00', sum / numberC);
    const sumStr: string = format('0.00', sum);
    const maxStr: string = format('0.00', max);
    const minStr: string = format('0.00', min);
    return { numberC, count, sum: sumStr, max: maxStr, min: minStr, average };
}
