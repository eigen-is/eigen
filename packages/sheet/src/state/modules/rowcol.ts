import type { MergeCell, SingleRange } from '@workspace/lib/sheets';
import { assign, clone, cloneDeep, forEach, isEmpty, size } from 'es-toolkit/compat';
import { applySheetsDeleteRowCol, applySheetsInsertRowCol } from '../../engine/rowcol';
import { type Context, getSheetConfig } from '../context';
import type { FilterEntry, FormulaCell, Sheet } from '../types';
import { getSheetIndex } from '../utils';

type FilterObj = { filterRange: SingleRange | null; filter: Record<string, FilterEntry> | null };

const refreshLocalMergeData = (merge_new: Record<string, MergeCell>, file: Sheet) => {
    for (const v of Object.values(merge_new)) {
        const { r, c, rs, cs } = v;

        // Engine inserts null for new cells inside an expanded merge range; the
        // canvas renderer needs `mc` on every cell of the range to hide them
        // behind the top-left, so stamp through nulls too.
        for (let i = r; i < r + rs; i += 1) {
            for (let j = c; j < c + cs; j += 1) {
                if (!file?.data?.[i]) continue;
                const existing = file.data[i][j];
                file.data[i][j] = existing ? assign(cloneDeep(existing), { mc: { r, c } }) : { mc: { r, c } };
            }
        }

        if (file?.data?.[r]) {
            const existing = file.data[r][c];
            file.data[r][c] = existing
                ? assign(cloneDeep(existing), { mc: { r, c, rs, cs } })
                : { mc: { r, c, rs, cs } };
        }
    }
};

type Axis = 'row' | 'column';

// Re-keys an "r_c" map for an insert: the row/column at `index` is the template (deep-copied onto
// every inserted one with `cloneTemplate`) and shifts along only for a lefttop insert.
function shiftKeyedMapForInsert<T>(
    map: Record<string, T>,
    axis: Axis,
    index: number,
    count: number,
    direction: 'lefttop' | 'rightbottom',
    cloneTemplate: boolean,
): Record<string, T> {
    const pos = axis === 'row' ? 0 : 1;
    const shifted: Record<string, T> = {};
    for (const [key, item] of Object.entries(map)) {
        const coord = key.split('_').map(Number);
        const at = coord[pos];
        if (at === index && cloneTemplate) {
            for (let n = 0; n < count; n += 1) {
                const inserted = [...coord];
                inserted[pos] = direction === 'rightbottom' ? index + n + 1 : index + n;
                shifted[inserted.join('_')] = cloneDeep(item);
            }
        }
        if (direction === 'lefttop' ? at >= index : at > index) coord[pos] += count;
        shifted[coord.join('_')] = item;
    }
    return shifted;
}

// Re-keys an "r_c" map for a delete: entries in [start, end] drop, the ones past it shift up.
function shiftKeyedMapForDelete<T>(map: Record<string, T>, axis: Axis, start: number, end: number): Record<string, T> {
    const pos = axis === 'row' ? 0 : 1;
    const shifted: Record<string, T> = {};
    for (const [key, item] of Object.entries(map)) {
        const coord = key.split('_').map(Number);
        const at = coord[pos];
        if (at >= start && at <= end) continue;
        if (at > end) coord[pos] -= end - start + 1;
        shifted[coord.join('_')] = item;
    }
    return shifted;
}

function shiftStateOnlyFieldsForInsert(
    ctx: Context,
    op: { type: 'row' | 'column'; index: number; count: number; direction: 'lefttop' | 'rightbottom'; id: string },
) {
    const { type, index, count, direction } = op;
    const id = op.id || ctx.currentSheetId;
    const curOrder = getSheetIndex(ctx, id);
    if (curOrder == null) return;
    const file = ctx.sheets[curOrder];
    if (!file) return;

    // calcChain entries are sheet-local; cross-sheet formula text is rewritten by the engine.
    const newCalcChain: FormulaCell[] = [];
    if (file.calcChain != null) {
        for (const entry of file.calcChain) {
            const calc: FormulaCell = cloneDeep(entry);
            if (type === 'row') {
                if (direction === 'lefttop' && calc.r >= index) calc.r += count;
                else if (direction === 'rightbottom' && calc.r > index) calc.r += count;
            } else {
                if (direction === 'lefttop' && calc.c >= index) calc.c += count;
                else if (direction === 'rightbottom' && calc.c > index) calc.c += count;
            }
            newCalcChain.push(calc);
        }
    }
    file.calcChain = newCalcChain;

    // Filter config update
    const cfg = file.config || {};
    const { filterRange } = file;
    const { filter } = file;
    let newFilterObj: FilterObj | null = null;
    if (!isEmpty(filterRange) && filterRange != null) {
        newFilterObj = { filterRange: null, filter: null };

        let f_r1 = filterRange.row[0];
        let f_r2 = filterRange.row[1];
        let f_c1 = filterRange.column[0];
        let f_c2 = filterRange.column[1];

        if (type === 'row') {
            if (f_r1 < index) {
                if (f_r2 === index && direction === 'lefttop') {
                    f_r2 += count;
                } else if (f_r2 > index) {
                    f_r2 += count;
                }
            } else if (f_r1 === index) {
                if (direction === 'lefttop') {
                    f_r1 += count;
                    f_r2 += count;
                } else if (direction === 'rightbottom' && f_r2 > index) {
                    f_r2 += count;
                }
            } else {
                f_r1 += count;
                f_r2 += count;
            }

            if (filter != null) {
                newFilterObj.filter = {};

                forEach(filter, (_v, k) => {
                    const f_rowhidden = filter[k].rowhidden;
                    const f_rowhidden_new: Record<string, number> = {};
                    forEach(f_rowhidden, (_v1, nstr) => {
                        const n = parseFloat(nstr);

                        if (n < index) {
                            f_rowhidden_new[n] = 0;
                        } else if (n === index) {
                            if (direction === 'lefttop') {
                                f_rowhidden_new[n + count] = 0;
                            } else if (direction === 'rightbottom') {
                                f_rowhidden_new[n] = 0;
                            }
                        } else {
                            f_rowhidden_new[n + count] = 0;
                        }
                    });
                    newFilterObj!.filter![k] = cloneDeep(filter[k]);
                    newFilterObj!.filter![k].rowhidden = f_rowhidden_new;
                    newFilterObj!.filter![k].str = f_r1;
                    newFilterObj!.filter![k].edr = f_r2;
                });
            }
        } else if (type === 'column') {
            if (f_c1 < index) {
                if (f_c2 === index && direction === 'lefttop') {
                    f_c2 += count;
                } else if (f_c2 > index) {
                    f_c2 += count;
                }
            } else if (f_c1 === index) {
                if (direction === 'lefttop') {
                    f_c1 += count;
                    f_c2 += count;
                } else if (direction === 'rightbottom' && f_c2 > index) {
                    f_c2 += count;
                }
            } else {
                f_c1 += count;
                f_c2 += count;
            }

            if (filter != null) {
                newFilterObj.filter = {};

                forEach(filter, (_v, k) => {
                    let f_cindex = filter[k].cindex;

                    if (f_cindex === index && direction === 'lefttop') {
                        f_cindex += count;
                    } else if (f_cindex > index) {
                        f_cindex += count;
                    }

                    newFilterObj!.filter![f_cindex - f_c1] = cloneDeep(filter[k]);
                    newFilterObj!.filter![f_cindex - f_c1].cindex = f_cindex;
                    newFilterObj!.filter![f_cindex - f_c1].stc = f_c1;
                    newFilterObj!.filter![f_cindex - f_c1].edc = f_c2;
                });
            }
        }

        newFilterObj.filterRange = { row: [f_r1, f_r2], column: [f_c1, f_c2] };
    }

    if (newFilterObj != null && newFilterObj.filter != null) {
        if (cfg.rowhidden == null) {
            cfg.rowhidden = {};
        }

        forEach(newFilterObj.filter, (_v, k) => {
            const f_rowhidden = newFilterObj!.filter![k].rowhidden;
            forEach(f_rowhidden, (_v1, n) => {
                cfg.rowhidden![n] = 0;
            });
        });
    }

    if (newFilterObj != null) {
        file.filter = newFilterObj.filter ?? undefined;
        file.filterRange = newFilterObj.filterRange ?? undefined;
    }

    // Freeze config update
    const { frozen } = file;
    if (frozen) {
        const normalizedIndex = direction === 'lefttop' ? index - 1 : index;
        if (type === 'row' && (frozen.type === 'rangeRow' || frozen.type === 'rangeBoth')) {
            if ((frozen.range?.row_focus ?? -1) > normalizedIndex) {
                frozen.range!.row_focus += count;
            }
        }
        if (type === 'column' && (frozen.type === 'rangeColumn' || frozen.type === 'rangeBoth')) {
            if ((frozen.range?.column_focus ?? -1) > normalizedIndex) {
                frozen.range!.column_focus += count;
            }
        }
    }

    // Inserted rows/columns clone the template's validation rules and borders, not its hyperlinks.
    // Rebuilding a map wholesale is deliberate: `patchToOp`'s sheetMetadataOps ships config whole.
    file.dataVerification = shiftKeyedMapForInsert(file.dataVerification ?? {}, type, index, count, direction, true);
    file.hyperlink = shiftKeyedMapForInsert(file.hyperlink ?? {}, type, index, count, direction, false);
    if (!isEmpty(cfg.borderInfo)) {
        cfg.borderInfo = shiftKeyedMapForInsert(cfg.borderInfo, type, index, count, direction, true);
    }
}

function shiftStateOnlyFieldsForDelete(
    ctx: Context,
    op: { type: 'row' | 'column'; start: number; end: number; id: string },
) {
    const { type, start, end } = op;
    const id = op.id || ctx.currentSheetId;
    const curOrder = getSheetIndex(ctx, id);
    if (curOrder == null) return;
    const file = ctx.sheets[curOrder];
    if (!file) return;

    const slen = end - start + 1;

    // calcChain entries are sheet-local; entries inside the deleted range drop out.
    const newCalcChain: FormulaCell[] = [];
    if (file.calcChain != null) {
        for (const entry of file.calcChain) {
            const calc: FormulaCell = cloneDeep(entry);
            if (type === 'row') {
                if (calc.r < start) newCalcChain.push(calc);
                else if (calc.r > end) {
                    calc.r -= slen;
                    newCalcChain.push(calc);
                }
            } else {
                if (calc.c < start) newCalcChain.push(calc);
                else if (calc.c > end) {
                    calc.c -= slen;
                    newCalcChain.push(calc);
                }
            }
        }
    }
    file.calcChain = newCalcChain;

    // Filter config update
    const cfg = file.config || {};
    const { filterRange } = file;
    const { filter } = file;
    let newFilterObj: FilterObj | null = null;
    if (!isEmpty(filterRange) && filterRange != null) {
        newFilterObj = { filterRange: null, filter: null };

        let f_r1 = filterRange.row[0];
        let f_r2 = filterRange.row[1];
        let f_c1 = filterRange.column[0];
        let f_c2 = filterRange.column[1];

        if (type === 'row') {
            if (f_r1 > end) {
                f_r1 -= slen;
                f_r2 -= slen;

                newFilterObj.filterRange = {
                    row: [f_r1, f_r2],
                    column: [f_c1, f_c2],
                };
            } else if (f_r1 < start) {
                if (f_r2 < start) {
                } else if (f_r2 <= end) {
                    f_r2 = start - 1;
                } else {
                    f_r2 -= slen;
                }

                newFilterObj.filterRange = {
                    row: [f_r1, f_r2],
                    column: [f_c1, f_c2],
                };
            }

            if (newFilterObj.filterRange != null && filter != null) {
                forEach(filter, (_v, k) => {
                    const f_rowhidden = filter[k].rowhidden;
                    const f_rowhidden_new: Record<string, number> = {};
                    forEach(f_rowhidden, (_v1, nstr) => {
                        const n = parseFloat(nstr);

                        if (n < start) {
                            f_rowhidden_new[n] = 0;
                        } else if (n > end) {
                            f_rowhidden_new[n - slen] = 0;
                        }
                    });

                    if (!isEmpty(f_rowhidden_new)) {
                        if (newFilterObj!.filter == null) {
                            newFilterObj!.filter = {};
                        }

                        newFilterObj!.filter[k] = cloneDeep(filter[k]);
                        newFilterObj!.filter[k].rowhidden = f_rowhidden_new;
                        newFilterObj!.filter[k].str = f_r1;
                        newFilterObj!.filter[k].edr = f_r2;
                    }
                });
            }
        } else if (type === 'column') {
            if (f_c1 > end) {
                f_c1 -= slen;
                f_c2 -= slen;

                newFilterObj.filterRange = {
                    row: [f_r1, f_r2],
                    column: [f_c1, f_c2],
                };
            } else if (f_c1 < start) {
                if (f_c2 < start) {
                } else if (f_c2 <= end) {
                    f_c2 = start - 1;
                } else {
                    f_c2 -= slen;
                }

                newFilterObj.filterRange = {
                    row: [f_r1, f_r2],
                    column: [f_c1, f_c2],
                };
            } else {
                if (f_c2 > end) {
                    f_c1 = start;
                    f_c2 -= slen;

                    newFilterObj.filterRange = {
                        row: [f_r1, f_r2],
                        column: [f_c1, f_c2],
                    };
                }
            }

            if (newFilterObj.filterRange != null && filter != null) {
                forEach(filter, (_v, k) => {
                    let f_cindex = filter[k].cindex;

                    if (f_cindex < start) {
                        if (newFilterObj!.filter == null) {
                            newFilterObj!.filter = {};
                        }

                        newFilterObj!.filter[f_cindex - f_c1] = cloneDeep(filter[k]);
                        newFilterObj!.filter[f_cindex - f_c1].edc = f_c2;
                    } else if (f_cindex > end) {
                        f_cindex -= slen;

                        if (newFilterObj!.filter == null) {
                            newFilterObj!.filter = {};
                        }

                        newFilterObj!.filter[f_cindex - f_c1] = cloneDeep(filter[k]);
                        newFilterObj!.filter[f_cindex - f_c1].cindex = f_cindex;
                        newFilterObj!.filter[f_cindex - f_c1].stc = f_c1;
                        newFilterObj!.filter[f_cindex - f_c1].edc = f_c2;
                    }
                });
            }
        }
    }

    if (newFilterObj != null && newFilterObj.filter != null) {
        if (cfg.rowhidden == null) {
            cfg.rowhidden = {};
        }

        forEach(newFilterObj.filter, (_v, k) => {
            const f_rowhidden = newFilterObj!.filter![k].rowhidden;
            forEach(f_rowhidden, (_v1, n) => {
                cfg.rowhidden![n] = 0;
            });
        });
    }

    if (newFilterObj != null) {
        file.filter = newFilterObj.filter ?? undefined;
        file.filterRange = newFilterObj.filterRange ?? undefined;
    }

    // Freeze config update
    const { frozen } = file;
    if (frozen) {
        if (type === 'row' && (frozen.type === 'rangeRow' || frozen.type === 'rangeBoth')) {
            if ((frozen.range?.row_focus ?? -1) >= start) {
                frozen.range!.row_focus -= Math.min(end, frozen.range!.row_focus) - start + 1;
            }
        }
        if (type === 'column' && (frozen.type === 'rangeColumn' || frozen.type === 'rangeBoth')) {
            if ((frozen.range?.column_focus ?? -1) >= start) {
                frozen.range!.column_focus -= Math.min(end, frozen.range!.column_focus) - start + 1;
            }
        }
    }

    file.dataVerification = shiftKeyedMapForDelete(file.dataVerification ?? {}, type, start, end);
    file.hyperlink = shiftKeyedMapForDelete(file.hyperlink ?? {}, type, start, end);
    if (!isEmpty(cfg.borderInfo)) cfg.borderInfo = shiftKeyedMapForDelete(cfg.borderInfo, type, start, end);
}

function adjustSelectionForInsert(
    ctx: Context,
    op: { type: 'row' | 'column'; index: number; count: number; direction: 'lefttop' | 'rightbottom'; id: string },
) {
    const { type, index, count, direction } = op;
    const id = op.id || ctx.currentSheetId;
    const curOrder = getSheetIndex(ctx, id);
    if (curOrder == null) return;
    const file = ctx.sheets[curOrder];
    if (!file) return;
    const d = file.data;
    if (!d) return;

    let range = null;
    if (type === 'row') {
        if (direction === 'lefttop') {
            range = [{ row: [index, index + count - 1], column: [0, d[0].length - 1] }];
        } else {
            range = [{ row: [index + 1, index + count], column: [0, d[0].length - 1] }];
        }
        file.row = d.length;
    } else {
        if (direction === 'lefttop') {
            range = [{ row: [0, d.length - 1], column: [index, index + count - 1] }];
        } else {
            range = [{ row: [0, d.length - 1], column: [index + 1, index + count] }];
        }
        file.column = d[0]?.length;
    }

    file.selections = range;
    if (file.id === ctx.currentSheetId) {
        ctx.selections = range;
    }
}

export function insertRowCol(
    ctx: Context,
    op: {
        type: 'row' | 'column';
        index: number;
        count: number;
        direction: 'lefttop' | 'rightbottom';
        id: string;
    },
    changeSelection: boolean = true,
    // Remote mirror (applyOp): re-derive the data shift even for a read-only viewer.
    // The permission guard blocks LOCAL viewer-initiated ops only.
    force: boolean = false,
) {
    if (!force && ctx.allowEdit === false) return;
    const id = op.id || ctx.currentSheetId;
    if (typeof id !== 'string') return;

    const { type, index, count, direction } = op;

    // Per-sheet write-back, not `ctx.sheets = ...`: a wholesale
    // reassignment makes immer emit one synthetic root-level replace patch
    // carrying the whole workbook, which is then shipped over collab on every
    // edit. See packages/sheet/src/state/test/modules/rowcol-patches.test.ts.
    const insertedSheets = applySheetsInsertRowCol(ctx.sheets, { ...op, id });
    for (let i = 0; i < insertedSheets.length; i += 1) {
        ctx.sheets[i] = insertedSheets[i];
    }

    const curOrder = getSheetIndex(ctx, id);
    if (curOrder == null) return;

    const file = ctx.sheets[curOrder];
    if (!file) return;

    const cfg = file.config || {};

    // rowReadOnly/colReadOnly shift (state-only; engine handles rowlen/columnlen/rowhidden/colhidden)
    if (type === 'row') {
        const rowReadOnly_new: Record<string, number> = {};
        forEach(cfg.rowReadOnly, (_v, rstr) => {
            const r = parseFloat(rstr);
            if (r < index) {
                rowReadOnly_new[r] = cfg.rowReadOnly![r];
            } else if (r > index) {
                rowReadOnly_new[r + count] = cfg.rowReadOnly![r];
            }
        });
        cfg.rowReadOnly = rowReadOnly_new;
    } else {
        const columnReadOnly_new: Record<string, number> = {};
        forEach(cfg.colReadOnly, (_v, cstr) => {
            const c = parseFloat(cstr);
            if (c < index) {
                columnReadOnly_new[c] = cfg.colReadOnly![c];
            } else if (c > index) {
                columnReadOnly_new[c + count] = cfg.colReadOnly![c];
            }
        });
        cfg.colReadOnly = columnReadOnly_new;
    }

    // Alternating colors config update
    const AFarr = file.alternateFormatRules;
    const newAFarr = [];
    if (AFarr != null && AFarr.length > 0) {
        for (let i = 0; i < AFarr.length; i += 1) {
            let AFr1 = AFarr[i].cellrange.row[0];
            let AFr2 = AFarr[i].cellrange.row[1];
            let AFc1 = AFarr[i].cellrange.column[0];
            let AFc2 = AFarr[i].cellrange.column[1];

            const af = clone(AFarr[i]);

            if (type === 'row') {
                if (AFr1 < index) {
                    if (AFr2 === index && direction === 'lefttop') {
                        AFr2 += count;
                    } else if (AFr2 > index) {
                        AFr2 += count;
                    }
                } else if (AFr1 === index) {
                    if (direction === 'lefttop') {
                        AFr1 += count;
                        AFr2 += count;
                    } else if (direction === 'rightbottom' && AFr2 > index) {
                        AFr2 += count;
                    }
                } else {
                    AFr1 += count;
                    AFr2 += count;
                }
            } else if (type === 'column') {
                if (AFc1 < index) {
                    if (AFc2 === index && direction === 'lefttop') {
                        AFc2 += count;
                    } else if (AFc2 > index) {
                        AFc2 += count;
                    }
                } else if (AFc1 === index) {
                    if (direction === 'lefttop') {
                        AFc1 += count;
                        AFc2 += count;
                    } else if (direction === 'rightbottom' && AFc2 > index) {
                        AFc2 += count;
                    }
                } else {
                    AFc1 += count;
                    AFc2 += count;
                }
            }

            af.cellrange = { row: [AFr1, AFr2], column: [AFc1, AFc2] };

            newAFarr.push(af);
        }
    }

    file.alternateFormatRules = newAFarr;
    file.config = cfg;

    shiftStateOnlyFieldsForInsert(ctx, { ...op, id });
    if (changeSelection) adjustSelectionForInsert(ctx, { ...op, id });

    const merge_new = file.config?.merge ?? {};
    refreshLocalMergeData(merge_new, file);

    ctx.formulaCache.formulaCellInfoMap = null;
}

export function deleteRowCol(
    ctx: Context,
    op: {
        type: 'row' | 'column';
        start: number;
        end: number;
        id: string;
    },
    // Remote mirror (applyOp): re-derive the data shift even for a read-only viewer.
    // The permission guard blocks LOCAL viewer-initiated ops only.
    force: boolean = false,
) {
    if (!force && ctx.allowEdit === false) return;
    const id = op.id || ctx.currentSheetId;
    if (typeof id !== 'string') return;

    const { type, start, end } = op;
    const slen = end - start + 1;

    // See insertRowCol above for why this isn't a wholesale reassignment.
    const deletedSheets = applySheetsDeleteRowCol(ctx.sheets, { ...op, id });
    for (let i = 0; i < deletedSheets.length; i += 1) {
        ctx.sheets[i] = deletedSheets[i];
    }

    const curOrder = getSheetIndex(ctx, id);
    if (curOrder == null) return;

    const file = ctx.sheets[curOrder];
    if (!file) return;

    const cfg = file.config || {};

    // rowReadOnly/colReadOnly shift (state-only; engine handles rowlen/columnlen/rowhidden/colhidden)
    if (type === 'row') {
        const rowReadOnly_new: Record<string, number> = {};
        forEach(cfg.rowReadOnly, (_v, rstr) => {
            const r = parseFloat(rstr);
            if (r < start) {
                rowReadOnly_new[r] = cfg.rowReadOnly![r];
            } else if (r > end) {
                rowReadOnly_new[r - slen] = cfg.rowReadOnly![r];
            }
        });
        cfg.rowReadOnly = rowReadOnly_new;
    } else {
        const columnReadOnly_new: Record<string, number> = {};
        forEach(cfg.colReadOnly, (_v, cstr) => {
            const c = parseFloat(cstr);
            if (c < start) {
                columnReadOnly_new[c] = cfg.colReadOnly![c];
            } else if (c > end) {
                columnReadOnly_new[c - slen] = cfg.colReadOnly![c];
            }
        });
        cfg.colReadOnly = columnReadOnly_new;
    }

    // Alternating colors config update
    const AFarr = file.alternateFormatRules;
    const newAFarr = [];
    if (AFarr != null && AFarr.length > 0) {
        for (let i = 0; i < AFarr.length; i += 1) {
            let AFr1 = AFarr[i].cellrange.row[0];
            let AFr2 = AFarr[i].cellrange.row[1];
            let AFc1 = AFarr[i].cellrange.column[0];
            let AFc2 = AFarr[i].cellrange.column[1];

            if (type === 'row') {
                if (!(AFr1 >= start && AFr2 <= end)) {
                    const af = clone(AFarr[i]);

                    if (AFr1 > end) {
                        AFr1 -= slen;
                        AFr2 -= slen;
                    } else if (AFr1 < start) {
                        if (AFr2 < start) {
                        } else if (AFr2 <= end) {
                            AFr2 = start - 1;
                        } else {
                            AFr2 -= slen;
                        }
                    } else {
                        if (AFr2 > end) {
                            AFr1 = start;
                            AFr2 -= slen;
                        }
                    }

                    af.cellrange = { row: [AFr1, AFr2], column: [AFc1, AFc2] };

                    newAFarr.push(af);
                }
            } else if (type === 'column') {
                if (!(AFc1 >= start && AFc2 <= end)) {
                    const af = clone(AFarr[i]);

                    if (AFc1 > end) {
                        AFc1 -= slen;
                        AFc2 -= slen;
                    } else if (AFc1 < start) {
                        if (AFc2 < start) {
                        } else if (AFc2 <= end) {
                            AFc2 = start - 1;
                        } else {
                            AFc2 -= slen;
                        }
                    } else {
                        if (AFc2 > end) {
                            AFc1 = start;
                            AFc2 -= slen;
                        }
                    }

                    af.cellrange = { row: [AFr1, AFr2], column: [AFc1, AFc2] };

                    newAFarr.push(af);
                }
            }
        }
    }

    file.alternateFormatRules = newAFarr;
    file.config = cfg;

    shiftStateOnlyFieldsForDelete(ctx, { ...op, id });
    ctx.selections = undefined;

    const merge_new = file.config?.merge ?? {};
    refreshLocalMergeData(merge_new, file);

    ctx.formulaCache.formulaCellInfoMap = null;
}

// Hide selected rows/columns
export function hideSelected(ctx: Context, type: string) {
    if (!ctx.selections || ctx.selections.length > 1) return 'noMulti';
    const index = getSheetIndex(ctx, ctx.currentSheetId) as number;
    const cfg = (ctx.sheets[index].config ??= {});
    // Hide rows
    if (type === 'row') {
        /* TODO: Sheet protection check
        if (
          !checkProtectionAuthorityNormal(Store.currentSheetIndex, "formatRows")
        ) {
          return ;
        } */
        const rowhidden = (cfg.rowhidden ??= {});
        const [r1, r2] = ctx.selections[0].row;
        const rowhiddenNumber = r2;
        for (let r = r1; r <= r2; r += 1) {
            rowhidden[r] = 0;
        }
        const rowLen = ctx.sheets[index].data!.length;
        const isEndRow =
            rowLen - 1 === rowhiddenNumber ||
            Object.keys(rowhidden).findIndex((o) => parseInt(o, 10) - 1 === rowhiddenNumber) >= 0;
        if (isEndRow) {
            ctx.selections[0].row[0] -= 1;
            ctx.selections[0].row[1] -= 1;
        } else {
            ctx.selections[0].row[0] += 1;
            ctx.selections[0].row[1] += 1;
        }
    } else if (type === 'column') {
        // Hide columns
        const colhidden = (cfg.colhidden ??= {});
        const c1 = ctx.selections[0].column[0];
        const c2 = ctx.selections[0].column[1];
        const colhiddenNumber = c2;
        for (let c = c1; c <= c2; c += 1) {
            colhidden[c] = 0;
        }
        const columnLen = ctx.sheets[index].data![0].length;
        // Check if the column to hide is the last column
        const isEndColumn =
            columnLen - 1 === colhiddenNumber ||
            Object.keys(colhidden).findIndex((o) => parseInt(o, 10) - 1 === colhiddenNumber) >= 0;
        if (isEndColumn) {
            ctx.selections[0].column[0] -= 1;
            ctx.selections[0].column[1] -= 1;
        } else {
            ctx.selections[0].column[0] += 1;
            ctx.selections[0].column[1] += 1;
        }
    }
    return '';
}

// Show (unhide) selected rows/columns
export function showSelected(ctx: Context, type: string) {
    if (!ctx.selections || ctx.selections.length > 1) return 'noMulti';
    // Unhiding cannot create hidden state, so it must not seed the map: on a sheet with
    // nothing hidden that would ship an op to peers and take an undo entry for a no-op.
    const cfg = getSheetConfig(ctx);
    if (type === 'row' && cfg?.rowhidden) {
        const [r1, r2] = ctx.selections[0].row;
        for (let r = r1; r <= r2; r += 1) {
            delete cfg.rowhidden[r];
        }
    } else if (type === 'column' && cfg?.colhidden) {
        const [c1, c2] = ctx.selections[0].column;
        for (let c = c1; c <= c2; c += 1) {
            delete cfg.colhidden[c];
        }
    }
    return '';
}

// Check if the current selection is on a hidden row/column
export function isShowHidenCR(ctx: Context): boolean {
    const cfg = getSheetConfig(ctx);
    if (!ctx.selections || (!cfg?.colhidden && !cfg?.rowhidden)) return false;
    // If the current selection is on a hidden row/column, it is not editable
    if (cfg?.colhidden && size(cfg.colhidden) >= 1) {
        const ctxColumn = ctx.selections[0]?.column?.[0];
        const isHidenColumn =
            Object.keys(cfg.colhidden).findIndex((o) => {
                return ctxColumn === parseInt(o, 10);
            }) >= 0;
        if (isHidenColumn) {
            return true;
        }
    }
    if (cfg?.rowhidden && size(cfg.rowhidden) >= 1) {
        const ctxRow = ctx.selections[0]?.row?.[0];
        const isHidenRow =
            Object.keys(cfg.rowhidden).findIndex((o) => {
                return ctxRow === parseInt(o, 10);
            }) >= 0;
        if (isHidenRow) {
            return true;
        }
    }
    return false;
}

// Count hidden rows/columns to skip during keyboard navigation
export function hideCRCount(ctx: Context, type: string): number {
    let count = 1;
    if (!ctx.selections) return 0;
    const section = ctx.selections[0];
    const cfg = getSheetConfig(ctx);
    const rowhidden = cfg?.rowhidden ?? {};
    const colhidden = cfg?.colhidden ?? {};
    if (type === 'ArrowUp' || type === 'ArrowDown') {
        const rowArr = Object.keys(rowhidden);
        if (type === 'ArrowUp') {
            let row = section.row[0] - 1;
            const rowIndex = rowArr.indexOf(row.toString());
            for (let i = rowIndex; i >= 0; i -= 1) {
                if (parseInt(rowArr[i], 10) === row) {
                    count += 1;
                    row -= 1;
                } else {
                    return count;
                }
            }
        } else {
            let row = section.row[0] + 1;
            const rowIndex = rowArr.indexOf(`${row}`);
            for (let i = rowIndex; i < rowArr.length; i += 1) {
                if (parseInt(rowArr[i], 10) === row) {
                    count += 1;
                    row += 1;
                } else {
                    return count;
                }
            }
        }
    } else if (type === 'ArrowLeft' || type === 'ArrowRight') {
        const columnArr = Object.keys(colhidden);
        if (type === 'ArrowLeft') {
            let column = section.column[0] - 1;
            const columnIndex = columnArr.indexOf(column.toString());
            for (let i = columnIndex; i >= 0; i -= 1) {
                if (parseInt(columnArr[i], 10) === column) {
                    count += 1;
                    column -= 1;
                } else {
                    return count;
                }
            }
        } else {
            let column = section.column[0] + 1;
            const columnIndex = columnArr.indexOf(`${column}`);
            for (let i = columnIndex; i < columnArr.length; i += 1) {
                if (parseInt(columnArr[i], 10) === column) {
                    count += 1;
                    column += 1;
                } else {
                    return count;
                }
            }
        }
    }

    return count;
}
