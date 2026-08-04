import type {
    BorderInfo,
    CellBorderInfo,
    DataVerificationRule,
    MergeCell,
    RangeBorderInfo,
    SingleRange,
} from '@workspace/lib/sheets';
import { assign, clone, cloneDeep, forEach, isEmpty, size } from 'es-toolkit/compat';
import { applySheetsDeleteRowCol, applySheetsInsertRowCol } from '../../engine/rowcol';
import type { Context } from '../context';
import type { FilterEntry, FormulaCell, Sheet, SheetConfig } from '../types';
import { getSheetIndex } from '../utils';

type FilterObj = { filterRange: SingleRange | null; filter: Record<string, FilterEntry> | null };

const refreshLocalMergeData = (merge_new: Record<string, MergeCell>, file: Sheet) => {
    Object.entries(merge_new).forEach(([, v]) => {
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
    });
};

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

    // Data validation config update — re-key entries without inspecting shape.
    const { dataVerification } = file;
    const newDataVerification: Record<string, DataVerificationRule> = {};
    if (dataVerification != null) {
        forEach(dataVerification, (_v, key) => {
            const r = Number(key.split('_')[0]);
            const c = Number(key.split('_')[1]);
            const item = dataVerification[key];

            if (type === 'row') {
                if (index < r) {
                    newDataVerification[`${r + count}_${c}`] = item;
                } else if (index === r) {
                    if (direction === 'lefttop') {
                        newDataVerification[`${r + count}_${c}`] = item;

                        for (let i = 0; i < count; i += 1) {
                            newDataVerification[`${r + i}_${c}`] = item;
                        }
                    } else {
                        newDataVerification[`${r}_${c}`] = item;

                        for (let i = 0; i < count; i += 1) {
                            newDataVerification[`${r + i + 1}_${c}`] = item;
                        }
                    }
                } else {
                    newDataVerification[`${r}_${c}`] = item;
                }
            } else if (type === 'column') {
                if (index < c) {
                    newDataVerification[`${r}_${c + count}`] = item;
                } else if (index === c) {
                    if (direction === 'lefttop') {
                        newDataVerification[`${r}_${c + count}`] = item;

                        for (let i = 0; i < count; i += 1) {
                            newDataVerification[`${r}_${c + i}`] = item;
                        }
                    } else {
                        newDataVerification[`${r}_${c}`] = item;

                        for (let i = 0; i < count; i += 1) {
                            newDataVerification[`${r}_${c + i + 1}`] = item;
                        }
                    }
                } else {
                    newDataVerification[`${r}_${c}`] = item;
                }
            }
        });
    }
    file.dataVerification = newDataVerification;

    // Hyperlink config update
    const { hyperlink } = file;
    const newHyperlink: Record<string, { linkType: string; linkAddress: string }> = {};
    if (hyperlink != null) {
        forEach(hyperlink, (_v, key) => {
            const r = Number(key.split('_')[0]);
            const c = Number(key.split('_')[1]);
            const item = hyperlink[key];

            if (type === 'row') {
                if (index < r) {
                    newHyperlink[`${r + count}_${c}`] = item;
                } else if (index === r) {
                    if (direction === 'lefttop') {
                        newHyperlink[`${r + count}_${c}`] = item;
                    } else {
                        newHyperlink[`${r}_${c}`] = item;
                    }
                } else {
                    newHyperlink[`${r}_${c}`] = item;
                }
            } else if (type === 'column') {
                if (index < c) {
                    newHyperlink[`${r}_${c + count}`] = item;
                } else if (index === c) {
                    if (direction === 'lefttop') {
                        newHyperlink[`${r}_${c + count}`] = item;
                    } else {
                        newHyperlink[`${r}_${c}`] = item;
                    }
                } else {
                    newHyperlink[`${r}_${c}`] = item;
                }
            }
        });
    }
    file.hyperlink = newHyperlink;
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

    // Data validation config update — re-key entries on delete (mirror of insert).
    const { dataVerification } = file;
    const newDataVerification: Record<string, DataVerificationRule> = {};
    if (dataVerification != null) {
        forEach(dataVerification, (_v, key) => {
            const r = Number(key.split('_')[0]);
            const c = Number(key.split('_')[1]);
            const item = dataVerification[key];

            if (type === 'row') {
                if (r < start) {
                    newDataVerification[`${r}_${c}`] = item;
                } else if (r > end) {
                    newDataVerification[`${r - slen}_${c}`] = item;
                }
            } else if (type === 'column') {
                if (c < start) {
                    newDataVerification[`${r}_${c}`] = item;
                } else if (c > end) {
                    newDataVerification[`${r}_${c - slen}`] = item;
                }
            }
        });
    }
    file.dataVerification = newDataVerification;

    // Hyperlink config update
    const { hyperlink } = file;
    const newHyperlink: Record<string, { linkType: string; linkAddress: string }> = {};
    if (hyperlink != null) {
        forEach(hyperlink, (_v, key) => {
            const r = Number(key.split('_')[0]);
            const c = Number(key.split('_')[1]);
            const item = hyperlink[key];

            if (type === 'row') {
                if (r < start) {
                    newHyperlink[`${r}_${c}`] = item;
                } else if (r > end) {
                    newHyperlink[`${r - slen}_${c}`] = item;
                }
            } else if (type === 'column') {
                if (c < start) {
                    newHyperlink[`${r}_${c}`] = item;
                } else if (c > end) {
                    newHyperlink[`${r}_${c - slen}`] = item;
                }
            }
        });
    }
    file.hyperlink = newHyperlink;
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

    // Border config update
    if (type === 'row') {
        const cellBorderConfig: CellBorderInfo[] = [];
        if (cfg.borderInfo && cfg.borderInfo.length > 0) {
            const borderInfo: BorderInfo[] = [];

            for (let i = 0; i < cfg.borderInfo.length; i += 1) {
                const entry = cfg.borderInfo[i];

                if (entry.rangeType === 'range') {
                    const emptyRange: SingleRange[] = [];

                    for (let j = 0; j < entry.range.length; j += 1) {
                        let bd_r1 = entry.range[j].row[0];
                        let bd_r2 = entry.range[j].row[1];

                        if (direction === 'lefttop') {
                            if (index <= bd_r1) {
                                bd_r1 += count;
                                bd_r2 += count;
                            } else if (index <= bd_r2) {
                                bd_r2 += count;
                            }
                        } else {
                            if (index < bd_r1) {
                                bd_r1 += count;
                                bd_r2 += count;
                            } else if (index < bd_r2) {
                                bd_r2 += count;
                            }
                        }

                        if (bd_r2 >= bd_r1) {
                            emptyRange.push({
                                row: [bd_r1, bd_r2],
                                column: entry.range[j].column,
                            });
                        }
                    }

                    if (emptyRange.length > 0) {
                        const bd_obj: RangeBorderInfo = {
                            rangeType: 'range',
                            borderType: entry.borderType,
                            style: entry.style,
                            color: entry.color,
                            range: emptyRange,
                        };

                        borderInfo.push(bd_obj);
                    }
                } else {
                    let { row_index } = entry.value;
                    // Cache border config at the same position
                    if (row_index === index) {
                        cellBorderConfig.push(cloneDeep(entry));
                    }

                    if (direction === 'lefttop') {
                        if (index <= row_index) {
                            row_index += count;
                        }
                    } else {
                        if (index < row_index) {
                            row_index += count;
                        }
                    }

                    entry.value.row_index = row_index;
                    borderInfo.push(entry);
                }
            }

            cfg.borderInfo = borderInfo;
        }

        // Copy cell-type borders for inserted rows
        if (cellBorderConfig.length) {
            for (let r = 0; r < count; r += 1) {
                const cellBorderConfigCopy = cloneDeep(cellBorderConfig);
                cellBorderConfigCopy.forEach((item) => {
                    if (direction === 'rightbottom') {
                        // Insert below: increment from template row position
                        item.value.row_index += r + 1;
                    } else if (direction === 'lefttop') {
                        // Insert above: target row shifts down, new rows inserted before it (increment from 0)
                        item.value.row_index += r;
                    }
                });
                cfg.borderInfo?.push(...cellBorderConfigCopy);
            }
        }
    } else {
        const cellBorderConfig: CellBorderInfo[] = [];
        if (cfg.borderInfo && cfg.borderInfo.length > 0) {
            const borderInfo: BorderInfo[] = [];

            for (let i = 0; i < cfg.borderInfo.length; i += 1) {
                const entry = cfg.borderInfo[i];

                if (entry.rangeType === 'range') {
                    const emptyRange: SingleRange[] = [];

                    for (let j = 0; j < entry.range.length; j += 1) {
                        let bd_c1 = entry.range[j].column[0];
                        let bd_c2 = entry.range[j].column[1];

                        if (direction === 'lefttop') {
                            if (index <= bd_c1) {
                                bd_c1 += count;
                                bd_c2 += count;
                            } else if (index <= bd_c2) {
                                bd_c2 += count;
                            }
                        } else {
                            if (index < bd_c1) {
                                bd_c1 += count;
                                bd_c2 += count;
                            } else if (index < bd_c2) {
                                bd_c2 += count;
                            }
                        }

                        if (bd_c2 >= bd_c1) {
                            emptyRange.push({
                                row: entry.range[j].row,
                                column: [bd_c1, bd_c2],
                            });
                        }
                    }

                    if (emptyRange.length > 0) {
                        const bd_obj: RangeBorderInfo = {
                            rangeType: 'range',
                            borderType: entry.borderType,
                            style: entry.style,
                            color: entry.color,
                            range: emptyRange,
                        };

                        borderInfo.push(bd_obj);
                    }
                } else {
                    let { col_index } = entry.value;
                    // Cache border config at the same position
                    if (col_index === index) {
                        cellBorderConfig.push(cloneDeep(entry));
                    }

                    if (direction === 'lefttop') {
                        if (index <= col_index) {
                            col_index += count;
                        }
                    } else {
                        if (index < col_index) {
                            col_index += count;
                        }
                    }

                    entry.value.col_index = col_index;
                    borderInfo.push(entry);
                }
            }

            cfg.borderInfo = borderInfo;
        }

        // Copy cell-type borders for inserted columns
        if (cellBorderConfig.length) {
            for (let i = 0; i < count; i += 1) {
                const cellBorderConfigCopy = cloneDeep(cellBorderConfig);
                cellBorderConfigCopy.forEach((item) => {
                    if (direction === 'rightbottom') {
                        // Insert right: increment from template column position
                        item.value.col_index += i + 1;
                    } else if (direction === 'lefttop') {
                        // Insert left: target column shifts right, new columns inserted before it (increment from 0)
                        item.value.col_index += i;
                    }
                });
                cfg.borderInfo?.push(...cellBorderConfigCopy);
            }
        }
    }

    file.alternateFormatRules = newAFarr;
    file.config = cfg;

    shiftStateOnlyFieldsForInsert(ctx, { ...op, id });
    if (changeSelection) adjustSelectionForInsert(ctx, { ...op, id });

    const merge_new = file.config?.merge ?? {};
    refreshLocalMergeData(merge_new, file);

    if (id === ctx.currentSheetId) {
        const i = getSheetIndex(ctx, id);
        if (typeof i === 'number') ctx.config = ctx.sheets[i].config!;
    }
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

    // Border config update
    if (type === 'row') {
        if (cfg.borderInfo && cfg.borderInfo.length > 0) {
            const borderInfo: BorderInfo[] = [];

            for (let i = 0; i < cfg.borderInfo.length; i += 1) {
                const entry = cfg.borderInfo[i];

                if (entry.rangeType === 'range') {
                    const emptyRange: SingleRange[] = [];

                    for (let j = 0; j < entry.range.length; j += 1) {
                        let bd_r1 = entry.range[j].row[0];
                        let bd_r2 = entry.range[j].row[1];

                        for (let r = start; r <= end; r += 1) {
                            if (r < entry.range[j].row[0]) {
                                bd_r1 -= 1;
                                bd_r2 -= 1;
                            } else if (r <= entry.range[j].row[1]) {
                                bd_r2 -= 1;
                            }
                        }

                        if (bd_r2 >= bd_r1) {
                            emptyRange.push({
                                row: [bd_r1, bd_r2],
                                column: entry.range[j].column,
                            });
                        }
                    }

                    if (emptyRange.length > 0) {
                        const bd_obj: RangeBorderInfo = {
                            rangeType: 'range',
                            borderType: entry.borderType,
                            style: entry.style,
                            color: entry.color,
                            range: emptyRange,
                        };

                        borderInfo.push(bd_obj);
                    }
                } else {
                    const { row_index } = entry.value;

                    if (row_index < start) {
                        borderInfo.push(entry);
                    } else if (row_index > end) {
                        entry.value.row_index = row_index - (end - start + 1);
                        borderInfo.push(entry);
                    }
                }
            }

            cfg.borderInfo = borderInfo;
        }
    } else {
        if (cfg.borderInfo && cfg.borderInfo.length > 0) {
            const borderInfo: BorderInfo[] = [];

            for (let i = 0; i < cfg.borderInfo.length; i += 1) {
                const entry = cfg.borderInfo[i];

                if (entry.rangeType === 'range') {
                    const emptyRange: SingleRange[] = [];

                    for (let j = 0; j < entry.range.length; j += 1) {
                        let bd_c1 = entry.range[j].column[0];
                        let bd_c2 = entry.range[j].column[1];

                        for (let c = start; c <= end; c += 1) {
                            if (c < entry.range[j].column[0]) {
                                bd_c1 -= 1;
                                bd_c2 -= 1;
                            } else if (c <= entry.range[j].column[1]) {
                                bd_c2 -= 1;
                            }
                        }

                        if (bd_c2 >= bd_c1) {
                            emptyRange.push({
                                row: entry.range[j].row,
                                column: [bd_c1, bd_c2],
                            });
                        }
                    }

                    if (emptyRange.length > 0) {
                        const bd_obj: RangeBorderInfo = {
                            rangeType: 'range',
                            borderType: entry.borderType,
                            style: entry.style,
                            color: entry.color,
                            range: emptyRange,
                        };

                        borderInfo.push(bd_obj);
                    }
                } else {
                    const { col_index } = entry.value;

                    if (col_index < start) {
                        borderInfo.push(entry);
                    } else if (col_index > end) {
                        entry.value.col_index = col_index - (end - start + 1);
                        borderInfo.push(entry);
                    }
                }
            }

            cfg.borderInfo = borderInfo;
        }
    }

    file.alternateFormatRules = newAFarr;
    file.config = cfg;

    shiftStateOnlyFieldsForDelete(ctx, { ...op, id });
    ctx.selections = undefined;

    const merge_new = file.config?.merge ?? {};
    refreshLocalMergeData(merge_new, file);

    if (id === ctx.currentSheetId) {
        const i = getSheetIndex(ctx, id);
        if (typeof i === 'number') ctx.config = ctx.sheets[i].config!;
    }
    ctx.formulaCache.formulaCellInfoMap = null;
}

// Compute cumulative row height array
export function computeRowlenArr(ctx: Context, rowHeight: number, cfg: SheetConfig) {
    const rowlenArr = [];
    let rh_height = 0;

    for (let i = 0; i < rowHeight; i += 1) {
        let rowlen = ctx.defaultrowlen;

        if (cfg.rowlen != null && cfg.rowlen[i] != null) {
            rowlen = cfg.rowlen[i];
        }

        if (cfg.rowhidden != null && cfg.rowhidden[i] != null) {
            rowlen = cfg.rowhidden[i];
            rowlenArr.push(rh_height);
            continue;
        } else {
            rh_height += rowlen + 1;
        }

        rowlenArr.push(rh_height); // Cumulative row height distribution
    }

    return rowlenArr;
}

// Hide selected rows/columns
export function hideSelected(ctx: Context, type: string) {
    if (!ctx.selections || ctx.selections.length > 1) return 'noMulti';
    const index = getSheetIndex(ctx, ctx.currentSheetId) as number;
    // Hide rows
    if (type === 'row') {
        /* TODO: Sheet protection check
        if (
          !checkProtectionAuthorityNormal(Store.currentSheetIndex, "formatRows")
        ) {
          return ;
        } */
        const rowhidden = ctx.config.rowhidden ?? {};
        const r1 = ctx.selections[0].row[0];
        const r2 = ctx.selections[0].row[1];
        const rowhiddenNumber = r2;
        for (let r = r1; r <= r2; r += 1) {
            rowhidden[r] = 0;
        }
        /* Undo/redo save. In Luckysheet this was done as follows, but in this project no extra handling is needed.
          if(Store.clearjfundo){
            let redo = {};
            redo["type"] = "showHidRows";
            redo["sheetIndex"] = Store.currentSheetIndex;
            redo["config"] = $.extend(true, {}, Store.config);
            redo["curconfig"] = cfg;

            Store.jfundo.length  = 0;
            Store.jfredo.push(redo);
        } */
        ctx.config.rowhidden = rowhidden;
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
        const colhidden = ctx.config.colhidden ?? {};
        const c1 = ctx.selections[0].column[0];
        const c2 = ctx.selections[0].column[1];
        const colhiddenNumber = c2;
        for (let c = c1; c <= c2; c += 1) {
            colhidden[c] = 0;
        }
        ctx.config.colhidden = colhidden;
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
    ctx.sheets[index].config = ctx.config;
    return '';
}

// Show (unhide) selected rows/columns
export function showSelected(ctx: Context, type: string) {
    if (!ctx.selections || ctx.selections.length > 1) return 'noMulti';
    const index = getSheetIndex(ctx, ctx.currentSheetId) as number;
    // Unhide rows
    if (type === 'row') {
        const rowhidden = ctx.config.rowhidden ?? {};
        const r1 = ctx.selections[0].row[0];
        const r2 = ctx.selections[0].row[1];
        for (let r = r1; r <= r2; r += 1) {
            delete rowhidden[r];
        }
        ctx.config.rowhidden = rowhidden;
    } else if (type === 'column') {
        // Unhide columns
        const colhidden = ctx.config.colhidden ?? {};
        const c1 = ctx.selections[0].column[0];
        const c2 = ctx.selections[0].column[1];
        for (let c = c1; c <= c2; c += 1) {
            delete colhidden[c];
        }
        ctx.config.colhidden = colhidden;
    }
    ctx.sheets[index].config = ctx.config;
    return '';
}

// Check if the current selection is on a hidden row/column
export function isShowHidenCR(ctx: Context): boolean {
    if (!ctx.selections || (!ctx.config.colhidden && !ctx.config.rowhidden)) return false;
    // If the current selection is on a hidden row/column, it is not editable
    if (ctx.config.colhidden && size(ctx.config.colhidden) >= 1) {
        const ctxColumn = ctx.selections[0]?.column?.[0];
        const isHidenColumn =
            Object.keys(ctx.config.colhidden).findIndex((o) => {
                return ctxColumn === parseInt(o, 10);
            }) >= 0;
        if (isHidenColumn) {
            return true;
        }
    }
    if (ctx.config.rowhidden && size(ctx.config.rowhidden) >= 1) {
        const ctxRow = ctx.selections[0]?.row?.[0];
        const isHidenRow =
            Object.keys(ctx.config.rowhidden).findIndex((o) => {
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
    const rowhidden = ctx.config.rowhidden ?? {};
    const colhidden = ctx.config.colhidden ?? {};
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
