// Row and column inserts, deletes, hides and unhides on the open workbook. The engine shifts the cells, merges
// and formulas of every sheet (applySheetsInsertRowCol, applySheetsDeleteRowCol); this module writes that result
// back into the editor's draft and shifts what only the editor keeps, such as the filter, read-only rows, the
// calc chain, validation rules, links and the selection. A local edit and a peer's op both come through here.

import { isRecord } from '@workspace/lib/guards';
import type { MergeCell, SingleRange } from '@workspace/lib/sheets';
import { assign, cloneDeep, forEach, isEmpty, size } from 'es-toolkit/compat';
import {
    applySheetsDeleteRowCol,
    applySheetsInsertRowCol,
    shiftCellKeyedForDelete,
    shiftCellKeyedForInsert,
    shiftRangeForDelete,
    shiftRangeForInsert,
} from '../../engine/rowcol';
import { getSheet } from '../api/common';
import type { Context } from '../context';
import { getSheetConfig } from '../context';
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

// Writes `frozen` whole, never into it: a peer's unfreeze removes it, and a write inside it would resolve on nothing.
function shiftFrozenFocus(file: Sheet, type: 'row' | 'column', shift: (focus: number) => number) {
    const { frozen } = file;
    if (!frozen?.range) return;
    const ranged = type === 'row' ? frozen.type === 'rangeRow' : frozen.type === 'rangeColumn';
    if (!ranged && frozen.type !== 'rangeBoth') return;
    const axis = type === 'row' ? 'row_focus' : 'column_focus';
    const focus = shift(frozen.range[axis]);
    if (focus !== frozen.range[axis]) file.frozen = { ...frozen, range: { ...frozen.range, [axis]: focus } };
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
                const shifted: Record<string, FilterEntry> = {};
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
                    shifted[k] = cloneDeep(filter[k]);
                    shifted[k].rowhidden = f_rowhidden_new;
                    shifted[k].str = f_r1;
                    shifted[k].edr = f_r2;
                });
                newFilterObj.filter = shifted;
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
                const shifted: Record<string, FilterEntry> = {};
                forEach(filter, (_v, k) => {
                    let f_cindex = filter[k].cindex;

                    if (f_cindex === index && direction === 'lefttop') {
                        f_cindex += count;
                    } else if (f_cindex > index) {
                        f_cindex += count;
                    }

                    shifted[f_cindex - f_c1] = cloneDeep(filter[k]);
                    shifted[f_cindex - f_c1].cindex = f_cindex;
                    shifted[f_cindex - f_c1].stc = f_c1;
                    shifted[f_cindex - f_c1].edc = f_c2;
                });
                newFilterObj.filter = shifted;
            }
        }

        newFilterObj.filterRange = { row: [f_r1, f_r2], column: [f_c1, f_c2] };
    }

    if (newFilterObj != null && newFilterObj.filter != null) {
        const rowhidden = (cfg.rowhidden ??= {});
        forEach(newFilterObj.filter, (entry) => {
            forEach(entry.rowhidden, (_v1, n) => {
                rowhidden[n] = 0;
            });
        });
    }

    if (newFilterObj != null) {
        file.filter = newFilterObj.filter ?? undefined;
        file.filterRange = newFilterObj.filterRange ?? undefined;
    }

    const normalizedIndex = direction === 'lefttop' ? index - 1 : index;
    shiftFrozenFocus(file, type, (focus) => (focus > normalizedIndex ? focus + count : focus));

    // Inserted rows/columns clone the template's validation rules, not its hyperlinks.
    file.dataVerification = shiftCellKeyedForInsert(file.dataVerification, type, index, count, direction, cloneDeep);
    file.hyperlink = shiftCellKeyedForInsert(file.hyperlink, type, index, count, direction);
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
                const shifted: Record<string, FilterEntry> = {};
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
                        shifted[k] = cloneDeep(filter[k]);
                        shifted[k].rowhidden = f_rowhidden_new;
                        shifted[k].str = f_r1;
                        shifted[k].edr = f_r2;
                    }
                });
                if (!isEmpty(shifted)) newFilterObj.filter = shifted;
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
                const shifted: Record<string, FilterEntry> = {};
                forEach(filter, (_v, k) => {
                    let f_cindex = filter[k].cindex;

                    if (f_cindex < start) {
                        shifted[f_cindex - f_c1] = cloneDeep(filter[k]);
                        shifted[f_cindex - f_c1].edc = f_c2;
                    } else if (f_cindex > end) {
                        f_cindex -= slen;
                        shifted[f_cindex - f_c1] = cloneDeep(filter[k]);
                        shifted[f_cindex - f_c1].cindex = f_cindex;
                        shifted[f_cindex - f_c1].stc = f_c1;
                        shifted[f_cindex - f_c1].edc = f_c2;
                    }
                });
                if (!isEmpty(shifted)) newFilterObj.filter = shifted;
            }
        }
    }

    if (newFilterObj != null && newFilterObj.filter != null) {
        const rowhidden = (cfg.rowhidden ??= {});
        forEach(newFilterObj.filter, (entry) => {
            forEach(entry.rowhidden, (_v1, n) => {
                rowhidden[n] = 0;
            });
        });
    }

    if (newFilterObj != null) {
        file.filter = newFilterObj.filter ?? undefined;
        file.filterRange = newFilterObj.filterRange ?? undefined;
    }

    shiftFrozenFocus(file, type, (focus) => (focus >= start ? focus - (Math.min(end, focus) - start + 1) : focus));

    file.dataVerification = shiftCellKeyedForDelete(file.dataVerification, type, start, end);
    file.hyperlink = shiftCellKeyedForDelete(file.hyperlink, type, start, end);
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

// Per sheet and per field, never `ctx.sheets = ...` or a whole sheet: a wholesale reassignment makes immer emit one
// replace carrying the whole workbook, shipped over collab on every edit (rowcol-patches.test.ts), and a whole sheet's
// undo would put back its images and charts over a peer's later ones. A moved chart gets only the fields that changed,
// its spec parts, a keyed part an entry at a time, so a peer's move or delete of it, or its edit of another entry, at
// once survives, and the undo puts back only the entries the op moved; an image never moves.
function writeBackSheets(ctx: Context, sheets: Sheet[]) {
    sheets.forEach((next, i) => {
        const sheet: Record<string, unknown> = ctx.sheets[i];
        for (const [key, value] of Object.entries(next)) {
            if (key !== 'charts' && sheet[key] !== value) sheet[key] = value;
        }
        const { charts } = ctx.sheets[i];
        for (const chart of Object.values(next.charts ?? {})) {
            const stored: Record<string, unknown> | undefined = charts?.[chart.id];
            if (!stored || stored === chart) continue;
            for (const [field, value] of Object.entries(chart)) {
                const record = stored[field];
                if (record === value) continue;
                if (isRecord(record) && isRecord(value)) writeEntries(record, value);
                else stored[field] = value;
            }
        }
    });
}

function writeEntries(record: Record<string, unknown>, next: Record<string, unknown>) {
    for (const [entry, value] of Object.entries(next)) if (record[entry] !== value) record[entry] = value;
    for (const entry of Object.keys(record)) if (!Object.hasOwn(next, entry)) delete record[entry];
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

    const { type, index, count } = op;

    writeBackSheets(ctx, applySheetsInsertRowCol(ctx.sheets, { ...op, id }));

    const curOrder = getSheetIndex(ctx, id);
    if (curOrder == null) return;

    const file = ctx.sheets[curOrder];
    if (!file) return;

    const cfg = file.config || {};

    // rowReadOnly/colReadOnly shift (state-only; engine handles rowlen/columnlen/rowhidden/colhidden)
    if (type === 'row') {
        const rowReadOnly_new: Record<string, number> = {};
        forEach(cfg.rowReadOnly, (readOnly, rstr) => {
            const r = parseFloat(rstr);
            if (r < index) {
                rowReadOnly_new[r] = readOnly;
            } else if (r > index) {
                rowReadOnly_new[r + count] = readOnly;
            }
        });
        cfg.rowReadOnly = rowReadOnly_new;
    } else {
        const columnReadOnly_new: Record<string, number> = {};
        forEach(cfg.colReadOnly, (readOnly, cstr) => {
            const c = parseFloat(cstr);
            if (c < index) {
                columnReadOnly_new[c] = readOnly;
            } else if (c > index) {
                columnReadOnly_new[c + count] = readOnly;
            }
        });
        cfg.colReadOnly = columnReadOnly_new;
    }

    file.alternateFormatRules = (file.alternateFormatRules ?? []).map((af) => ({
        ...af,
        cellrange: shiftRangeForInsert(af.cellrange, op),
    }));
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

    writeBackSheets(ctx, applySheetsDeleteRowCol(ctx.sheets, { ...op, id }));

    const curOrder = getSheetIndex(ctx, id);
    if (curOrder == null) return;

    const file = ctx.sheets[curOrder];
    if (!file) return;

    const cfg = file.config || {};

    // rowReadOnly/colReadOnly shift (state-only; engine handles rowlen/columnlen/rowhidden/colhidden)
    if (type === 'row') {
        const rowReadOnly_new: Record<string, number> = {};
        forEach(cfg.rowReadOnly, (readOnly, rstr) => {
            const r = parseFloat(rstr);
            if (r < start) {
                rowReadOnly_new[r] = readOnly;
            } else if (r > end) {
                rowReadOnly_new[r - slen] = readOnly;
            }
        });
        cfg.rowReadOnly = rowReadOnly_new;
    } else {
        const columnReadOnly_new: Record<string, number> = {};
        forEach(cfg.colReadOnly, (readOnly, cstr) => {
            const c = parseFloat(cstr);
            if (c < start) {
                columnReadOnly_new[c] = readOnly;
            } else if (c > end) {
                columnReadOnly_new[c - slen] = readOnly;
            }
        });
        cfg.colReadOnly = columnReadOnly_new;
    }

    const alternateFormats = [];
    for (const af of file.alternateFormatRules ?? []) {
        const cellrange = shiftRangeForDelete(af.cellrange, op);
        if (cellrange) alternateFormats.push({ ...af, cellrange });
    }
    file.alternateFormatRules = alternateFormats;
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
    const sheet = getSheet(ctx);
    const { data } = sheet;
    // A sheet that is not loaded has nothing to hide.
    if (!data) return '';
    const cfg = (sheet.config ??= {});
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
        const rowLen = data.length;
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
        const columnLen = data[0].length;
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
