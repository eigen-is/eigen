import type { MergeCell, Sheet } from '@workspace/lib/sheets';
import { functionStrChange } from './formula-shift';
import type { ExtendedSheetConfig } from './types';

export type InsertRowColOp = {
    type: 'row' | 'column';
    index: number;
    count: number;
    direction: 'lefttop' | 'rightbottom';
    id: string;
};

export type DeleteRowColOp = {
    type: 'row' | 'column';
    start: number;
    end: number;
    id: string;
};

export type RowColErrorCode = 'readOnly' | 'maxExceeded';

// Engine signals an aborted row/col op via this typed error rather than a
// bare-string `new Error('readOnly')`. UI callers (ContextMenu/MenuBar) branch
// on `code`; the BE replay path catches and skips. The contract is enforced at
// the type level so the catch sites don't depend on message punctuation.
export class RowColError extends Error {
    readonly code: RowColErrorCode;

    constructor(code: RowColErrorCode) {
        super(code);
        this.name = 'RowColError';
        this.code = code;
    }
}

// lib's `SheetConfig` types only the fields the BE serializes. The engine's
// row/col shifter also touches editor-runtime fields that live alongside but
// aren't lib-typed — see `EditorSheetConfigExtras` in `./types`.

// Generic over S so the state-side state.Sheet[] passes through with its extras
// (filter / frozen / dataVerification / ...) typed end-to-end. The engine only
// reads lib.Sheet-typed fields; shallow copies preserve the wider input shape.
//
// All rebuilds use structural sharing, never a deep clone: rows (and cells, for
// column ops) that an operation doesn't touch are reused by reference. On the FE
// the inputs are immer drafts and the result is assigned back into the draft —
// untouched rows finalize to their unchanged bases, so a row insert no longer
// pays a deep walk over every cell (multi-second on large sheets).
export function applySheetsInsertRowCol<S extends Sheet>(sheets: S[], op: InsertRowColOp): S[] {
    const targetIndex = sheets.findIndex((s) => s.id === op.id);
    if (targetIndex === -1) return sheets;
    return applyInsert(sheets, targetIndex, op);
}

export function applySheetsDeleteRowCol<S extends Sheet>(sheets: S[], op: DeleteRowColOp): S[] {
    const targetIndex = sheets.findIndex((s) => s.id === op.id);
    if (targetIndex === -1) return sheets;
    return applyDelete(sheets, targetIndex, op);
}

function shiftMergeForInsert(
    cfg: ExtendedSheetConfig,
    type: 'row' | 'column',
    index: number,
    count: number,
    direction: 'lefttop' | 'rightbottom',
): Record<string, MergeCell> {
    const merge_new: Record<string, MergeCell> = {};
    for (const mc of Object.values(cfg.merge ?? {})) {
        const { r, c, rs, cs } = mc;
        if (type === 'row') {
            if (index < r) {
                merge_new[`${r + count}_${c}`] = { r: r + count, c, rs, cs };
            } else if (index === r) {
                if (direction === 'lefttop') {
                    merge_new[`${r + count}_${c}`] = { r: r + count, c, rs, cs };
                } else {
                    merge_new[`${r}_${c}`] = { r, c, rs: rs + count, cs };
                }
            } else if (index < r + rs - 1) {
                merge_new[`${r}_${c}`] = { r, c, rs: rs + count, cs };
            } else if (index === r + rs - 1) {
                if (direction === 'lefttop') {
                    merge_new[`${r}_${c}`] = { r, c, rs: rs + count, cs };
                } else {
                    merge_new[`${r}_${c}`] = { r, c, rs, cs };
                }
            } else {
                merge_new[`${r}_${c}`] = { r, c, rs, cs };
            }
        } else {
            if (index < c) {
                merge_new[`${r}_${c + count}`] = { r, c: c + count, rs, cs };
            } else if (index === c) {
                if (direction === 'lefttop') {
                    merge_new[`${r}_${c + count}`] = { r, c: c + count, rs, cs };
                } else {
                    merge_new[`${r}_${c}`] = { r, c, rs, cs: cs + count };
                }
            } else if (index < c + cs - 1) {
                merge_new[`${r}_${c}`] = { r, c, rs, cs: cs + count };
            } else if (index === c + cs - 1) {
                if (direction === 'lefttop') {
                    merge_new[`${r}_${c}`] = { r, c, rs, cs: cs + count };
                } else {
                    merge_new[`${r}_${c}`] = { r, c, rs, cs };
                }
            } else {
                merge_new[`${r}_${c}`] = { r, c, rs, cs };
            }
        }
    }
    return merge_new;
}

function shiftMergeForDelete(
    cfg: ExtendedSheetConfig,
    type: 'row' | 'column',
    start: number,
    slen: number,
): Record<string, MergeCell> {
    const end = start + slen - 1;
    const merge_new: Record<string, MergeCell> = {};
    for (const mc of Object.values(cfg.merge ?? {})) {
        const { r, c, rs, cs } = mc;
        if (type === 'row') {
            if (r < start) {
                if (r + rs - 1 < start) {
                    merge_new[`${r}_${c}`] = { r, c, rs, cs };
                } else if (r + rs - 1 >= start && r + rs - 1 < end) {
                    merge_new[`${r}_${c}`] = { r, c, rs: start - r, cs };
                } else if (r + rs - 1 >= end) {
                    merge_new[`${r}_${c}`] = { r, c, rs: rs - slen, cs };
                }
            } else if (r >= start && r <= end) {
                if (r + rs - 1 > end) {
                    merge_new[`${start}_${c}`] = { r: start, c, rs: r + rs - 1 - end, cs };
                }
            } else if (r > end) {
                merge_new[`${r - slen}_${c}`] = { r: r - slen, c, rs, cs };
            }
        } else {
            if (c < start) {
                if (c + cs - 1 < start) {
                    merge_new[`${r}_${c}`] = { r, c, rs, cs };
                } else if (c + cs - 1 >= start && c + cs - 1 < end) {
                    merge_new[`${r}_${c}`] = { r, c, rs, cs: start - c };
                } else if (c + cs - 1 >= end) {
                    merge_new[`${r}_${c}`] = { r, c, rs, cs: cs - slen };
                }
            } else if (c >= start && c <= end) {
                if (c + cs - 1 > end) {
                    merge_new[`${r}_${start}`] = { r, c: start, rs, cs: c + cs - 1 - end };
                }
            } else if (c > end) {
                merge_new[`${r}_${c - slen}`] = { r, c: c - slen, rs, cs };
            }
        }
    }
    return merge_new;
}

function shiftFormulasAcrossSheets<S extends Sheet>(
    sheets: S[],
    type: 'row' | 'column',
    direction: 'lefttop' | 'rightbottom' | null,
    index: number,
    count: number,
    op: 'add' | 'del',
): S[] {
    return sheets.map((sheet) => {
        if (!sheet.data) return sheet;
        let newData: typeof sheet.data | null = null;
        for (let r = 0; r < sheet.data.length; r += 1) {
            const row = sheet.data[r];
            if (!row) continue;
            for (let c = 0; c < row.length; c += 1) {
                const cell = row[c];
                if (!cell?.f) continue;
                const txt = cell.f.startsWith('=') ? cell.f.slice(1) : cell.f;
                const shifted = functionStrChange(txt, op, type === 'row' ? 'row' : 'col', direction, index, count);
                const newF = `=${shifted}`;
                if (newF === cell.f) continue;
                if (!newData) newData = [...sheet.data];
                if (newData[r] === row) newData[r] = [...row];
                newData[r][c] = { ...cell, f: newF };
            }
        }
        return newData ? { ...sheet, data: newData } : sheet;
    });
}

// config carries several index-keyed maps (rowlen, rowhidden, customHeight and
// their column twins) that all shift identically when rows/columns move.
function shiftKeyedMapForInsert(
    map: Record<string, number>,
    index: number,
    count: number,
    direction: 'lefttop' | 'rightbottom',
): Record<string, number> {
    const shifted: Record<string, number> = {};
    for (const [key, v] of Object.entries(map)) {
        const i = Number.parseInt(key, 10);
        if (i < index || (i === index && direction === 'rightbottom')) shifted[i] = v;
        else shifted[i + count] = v;
    }
    return shifted;
}

function shiftKeyedMapForDelete(map: Record<string, number>, start: number, end: number): Record<string, number> {
    const shifted: Record<string, number> = {};
    const removeCount = end - start + 1;
    for (const [key, v] of Object.entries(map)) {
        const i = Number.parseInt(key, 10);
        if (i < start) shifted[i] = v;
        else if (i > end) shifted[i - removeCount] = v;
    }
    return shifted;
}

function applyInsert<S extends Sheet>(sheets: S[], targetIndex: number, op: InsertRowColOp): S[] {
    const target = sheets[targetIndex];
    const cfg = (target.config ?? {}) as ExtendedSheetConfig;
    const data = target.data;
    if (!data) return sheets;

    if (op.type === 'row' && cfg.rowReadOnly?.[op.index]) throw new RowColError('readOnly');
    if (op.type === 'column' && cfg.colReadOnly?.[op.index]) throw new RowColError('readOnly');
    if (op.type === 'row' && data.length + op.count >= 10000) throw new RowColError('maxExceeded');
    if (op.type === 'column' && data[0] && data[0].length + op.count >= 1000) throw new RowColError('maxExceeded');

    const { count } = op;
    const newTarget = { ...target };
    const newCfg = { ...(target.config ?? {}) } as ExtendedSheetConfig;
    const newData = op.type === 'row' ? [...data] : data.map((row) => [...row]);
    newTarget.data = newData;
    const insertAt = op.direction === 'lefttop' ? op.index : op.index + 1;

    newCfg.merge = shiftMergeForInsert(cfg, op.type, op.index, count, op.direction);

    if (op.type === 'row') {
        if (cfg.rowhidden != null)
            newCfg.rowhidden = shiftKeyedMapForInsert(cfg.rowhidden, op.index, count, op.direction);
        if (cfg.rowlen != null) newCfg.rowlen = shiftKeyedMapForInsert(cfg.rowlen, op.index, count, op.direction);
        if (cfg.customHeight != null)
            newCfg.customHeight = shiftKeyedMapForInsert(cfg.customHeight, op.index, count, op.direction);

        const cols = newData[0]?.length ?? 0;
        const blank = () => new Array<null>(cols).fill(null);
        // Single splice: one-at-a-time inserts re-shift the tail per row.
        const blankRows: (typeof newData)[number][] = [];
        for (let i = 0; i < count; i += 1) blankRows.push(blank());
        newData.splice(insertAt, 0, ...blankRows);
    } else {
        if (cfg.colhidden != null)
            newCfg.colhidden = shiftKeyedMapForInsert(cfg.colhidden, op.index, count, op.direction);
        if (cfg.columnlen != null)
            newCfg.columnlen = shiftKeyedMapForInsert(cfg.columnlen, op.index, count, op.direction);
        if (cfg.customWidth != null)
            newCfg.customWidth = shiftKeyedMapForInsert(cfg.customWidth, op.index, count, op.direction);

        const blanks = new Array<null>(count).fill(null);
        for (const row of newData) {
            row.splice(insertAt, 0, ...blanks);
        }
    }

    newTarget.config = newCfg;

    if (target.conditionalFormatRules != null) {
        newTarget.conditionalFormatRules = target.conditionalFormatRules.map((cf) => {
            const newRanges = cf.cellrange.map((range) => {
                let r1 = range.row[0];
                let r2 = range.row[1];
                let c1 = range.column[0];
                let c2 = range.column[1];
                if (op.type === 'row') {
                    if (r1 < op.index) {
                        if (r2 === op.index && op.direction === 'lefttop') {
                            r2 += count;
                        } else if (r2 > op.index) {
                            r2 += count;
                        }
                    } else if (r1 === op.index) {
                        if (op.direction === 'lefttop') {
                            r1 += count;
                            r2 += count;
                        } else if (op.direction === 'rightbottom' && r2 > op.index) {
                            r2 += count;
                        }
                    } else {
                        r1 += count;
                        r2 += count;
                    }
                } else {
                    if (c1 < op.index) {
                        if (c2 === op.index && op.direction === 'lefttop') {
                            c2 += count;
                        } else if (c2 > op.index) {
                            c2 += count;
                        }
                    } else if (c1 === op.index) {
                        if (op.direction === 'lefttop') {
                            c1 += count;
                            c2 += count;
                        } else if (op.direction === 'rightbottom' && c2 > op.index) {
                            c2 += count;
                        }
                    } else {
                        c1 += count;
                        c2 += count;
                    }
                }
                return { row: [r1, r2], column: [c1, c2] };
            });
            return { ...cf, cellrange: newRanges };
        });
    }

    let result: S[] = [...sheets.slice(0, targetIndex), newTarget, ...sheets.slice(targetIndex + 1)];
    result = shiftFormulasAcrossSheets(result, op.type, op.direction, op.index, count, 'add');
    return result;
}

function applyDelete<S extends Sheet>(sheets: S[], targetIndex: number, op: DeleteRowColOp): S[] {
    const target = sheets[targetIndex];
    const data = target.data;
    if (!data) return sheets;

    const cfg = (target.config ?? {}) as ExtendedSheetConfig;

    if (op.type === 'row' && cfg.rowReadOnly) {
        for (let i = op.start; i <= op.end; i += 1) {
            if (cfg.rowReadOnly[i]) throw new RowColError('readOnly');
        }
    }
    if (op.type === 'column' && cfg.colReadOnly) {
        for (let i = op.start; i <= op.end; i += 1) {
            if (cfg.colReadOnly[i]) throw new RowColError('readOnly');
        }
    }

    const newTarget = { ...target };
    const newCfg = { ...(target.config ?? {}) } as ExtendedSheetConfig;
    const newData = op.type === 'row' ? [...data] : data.map((row) => [...row]);
    newTarget.data = newData;
    const removeCount = op.end - op.start + 1;

    newCfg.merge = shiftMergeForDelete(cfg, op.type, op.start, removeCount);

    if (op.type === 'row') {
        if (cfg.rowhidden != null) newCfg.rowhidden = shiftKeyedMapForDelete(cfg.rowhidden, op.start, op.end);
        if (cfg.rowlen != null) newCfg.rowlen = shiftKeyedMapForDelete(cfg.rowlen, op.start, op.end);
        if (cfg.customHeight != null) newCfg.customHeight = shiftKeyedMapForDelete(cfg.customHeight, op.start, op.end);

        newData.splice(op.start, removeCount);
    } else {
        if (cfg.colhidden != null) newCfg.colhidden = shiftKeyedMapForDelete(cfg.colhidden, op.start, op.end);
        if (cfg.columnlen != null) newCfg.columnlen = shiftKeyedMapForDelete(cfg.columnlen, op.start, op.end);
        if (cfg.customWidth != null) newCfg.customWidth = shiftKeyedMapForDelete(cfg.customWidth, op.start, op.end);

        for (const row of newData) row.splice(op.start, removeCount);
    }

    newTarget.config = newCfg;

    if (target.conditionalFormatRules != null) {
        const newCFarr = [];
        for (const cf of target.conditionalFormatRules) {
            const cf_new_range = [];
            for (const range of cf.cellrange) {
                let r1 = range.row[0];
                let r2 = range.row[1];
                let c1 = range.column[0];
                let c2 = range.column[1];
                if (op.type === 'row') {
                    if (!(r1 >= op.start && r2 <= op.end)) {
                        if (r1 > op.end) {
                            r1 -= removeCount;
                            r2 -= removeCount;
                        } else if (r1 < op.start) {
                            if (r2 >= op.start && r2 <= op.end) {
                                r2 = op.start - 1;
                            } else if (r2 > op.end) {
                                r2 -= removeCount;
                            }
                        } else {
                            if (r2 > op.end) {
                                r1 = op.start;
                                r2 -= removeCount;
                            }
                        }
                        cf_new_range.push({ row: [r1, r2], column: [c1, c2] });
                    }
                } else {
                    if (!(c1 >= op.start && c2 <= op.end)) {
                        if (c1 > op.end) {
                            c1 -= removeCount;
                            c2 -= removeCount;
                        } else if (c1 < op.start) {
                            if (c2 >= op.start && c2 <= op.end) {
                                c2 = op.start - 1;
                            } else if (c2 > op.end) {
                                c2 -= removeCount;
                            }
                        } else {
                            if (c2 > op.end) {
                                c1 = op.start;
                                c2 -= removeCount;
                            }
                        }
                        cf_new_range.push({ row: [r1, r2], column: [c1, c2] });
                    }
                }
            }
            if (cf_new_range.length > 0) {
                newCFarr.push({ ...cf, cellrange: cf_new_range });
            }
        }
        newTarget.conditionalFormatRules = newCFarr;
    }

    let result: S[] = [...sheets.slice(0, targetIndex), newTarget, ...sheets.slice(targetIndex + 1)];
    result = shiftFormulasAcrossSheets(result, op.type, null, op.start, removeCount, 'del');
    return result;
}
