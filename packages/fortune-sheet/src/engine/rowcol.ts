import type { Sheet, SheetConfig } from '@workspace/lib/sheets';
import { cloneDeep } from 'es-toolkit/compat';
import { functionStrChange } from './formula-shift';

export type RowColOp =
    | {
          mode: 'insert';
          type: 'row' | 'column';
          index: number;
          count: number;
          direction: 'lefttop' | 'rightbottom';
          id: string;
      }
    | {
          mode: 'delete';
          type: 'row' | 'column';
          start: number;
          end: number;
          id: string;
      };

type ExtendedSheetConfig = SheetConfig & {
    rowReadOnly?: Record<string, number>;
    colReadOnly?: Record<string, number>;
    customHeight?: Record<string, number>;
    customWidth?: Record<string, number>;
};

export function applySheetsRowColOp(sheets: Sheet[], op: RowColOp): Sheet[] {
    const targetIndex = sheets.findIndex((s) => s.id === op.id);
    if (targetIndex === -1) return sheets;

    if (op.mode === 'insert') return applyInsert(sheets, targetIndex, op);
    return applyDelete(sheets, targetIndex, op);
}

function shiftMergeForInsert(
    cfg: ExtendedSheetConfig,
    type: 'row' | 'column',
    index: number,
    count: number,
    direction: 'lefttop' | 'rightbottom',
): Record<string, { r: number; c: number; rs: number; cs: number }> {
    const merge_new: Record<string, { r: number; c: number; rs: number; cs: number }> = {};
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
): Record<string, { r: number; c: number; rs: number; cs: number }> {
    const end = start + slen - 1;
    const merge_new: Record<string, { r: number; c: number; rs: number; cs: number }> = {};
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

function shiftFormulasAcrossSheets(
    sheets: Sheet[],
    type: 'row' | 'column',
    direction: 'lefttop' | 'rightbottom' | null,
    index: number,
    count: number,
    op: 'add' | 'del',
): Sheet[] {
    return sheets.map((sheet) => {
        if (!sheet.data) return sheet;
        let cloned: Sheet | null = null;
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
                if (!cloned) cloned = cloneDeep(sheet);
                cloned.data![r]![c]!.f = newF;
            }
        }
        return cloned ?? sheet;
    });
}

function applyInsert(sheets: Sheet[], targetIndex: number, op: Extract<RowColOp, { mode: 'insert' }>): Sheet[] {
    const target = sheets[targetIndex];
    const cfg = (target.config ?? {}) as ExtendedSheetConfig;
    const data = target.data;
    if (!data) return sheets;

    if (op.type === 'row' && cfg.rowReadOnly?.[op.index]) throw new Error('readOnly');
    if (op.type === 'column' && cfg.colReadOnly?.[op.index]) throw new Error('readOnly');
    if (op.type === 'row' && data.length + op.count >= 10000) throw new Error('maxExceeded');
    if (op.type === 'column' && data[0] && data[0].length + op.count >= 1000) throw new Error('maxExceeded');

    const { count } = op;
    const newTarget = cloneDeep(target);
    const newCfg = (newTarget.config ?? {}) as ExtendedSheetConfig;
    const newData = newTarget.data!;
    const insertAt = op.direction === 'lefttop' ? op.index : op.index + 1;

    newCfg.merge = shiftMergeForInsert(cfg, op.type, op.index, count, op.direction);

    if (op.type === 'row') {
        if (cfg.rowhidden != null) {
            const rowhidden_new: Record<string, number> = {};
            for (const [rstr, v] of Object.entries(cfg.rowhidden)) {
                const r = Number.parseInt(rstr, 10);
                if (r < op.index) {
                    rowhidden_new[r] = v;
                } else if (r === op.index) {
                    if (op.direction === 'lefttop') {
                        rowhidden_new[r + count] = v;
                    } else {
                        rowhidden_new[r] = v;
                    }
                } else {
                    rowhidden_new[r + count] = v;
                }
            }
            newCfg.rowhidden = rowhidden_new;
        }

        if (cfg.rowlen != null) {
            const rowlen_new: Record<string, number> = {};
            for (const [rstr, v] of Object.entries(cfg.rowlen)) {
                const r = Number.parseInt(rstr, 10);
                if (r < op.index) {
                    rowlen_new[r] = v;
                } else if (r === op.index) {
                    if (op.direction === 'lefttop') {
                        rowlen_new[r + count] = v;
                    } else {
                        rowlen_new[r] = v;
                    }
                } else {
                    rowlen_new[r + count] = v;
                }
            }
            newCfg.rowlen = rowlen_new;
        }

        if (cfg.customHeight != null) {
            const customHeight_new: Record<string, number> = {};
            for (const [rstr, v] of Object.entries(cfg.customHeight)) {
                const r = Number.parseInt(rstr, 10);
                if (r < op.index) {
                    customHeight_new[r] = v;
                } else if (r === op.index) {
                    if (op.direction === 'lefttop') {
                        customHeight_new[r + count] = v;
                    } else {
                        customHeight_new[r] = v;
                    }
                } else {
                    customHeight_new[r + count] = v;
                }
            }
            newCfg.customHeight = customHeight_new;
        }

        const cols = newData[0]?.length ?? 0;
        const blank = () => new Array<null>(cols).fill(null);
        for (let i = 0; i < count; i += 1) newData.splice(insertAt, 0, blank());
    } else {
        if (cfg.colhidden != null) {
            const colhidden_new: Record<string, number> = {};
            for (const [cstr, v] of Object.entries(cfg.colhidden)) {
                const c = Number.parseInt(cstr, 10);
                if (c < op.index) {
                    colhidden_new[c] = v;
                } else if (c === op.index) {
                    if (op.direction === 'lefttop') {
                        colhidden_new[c + count] = v;
                    } else {
                        colhidden_new[c] = v;
                    }
                } else {
                    colhidden_new[c + count] = v;
                }
            }
            newCfg.colhidden = colhidden_new;
        }

        if (cfg.columnlen != null) {
            const columnlen_new: Record<string, number> = {};
            for (const [cstr, v] of Object.entries(cfg.columnlen)) {
                const c = Number.parseInt(cstr, 10);
                if (c < op.index) {
                    columnlen_new[c] = v;
                } else if (c === op.index) {
                    if (op.direction === 'lefttop') {
                        columnlen_new[c + count] = v;
                    } else {
                        columnlen_new[c] = v;
                    }
                } else {
                    columnlen_new[c + count] = v;
                }
            }
            newCfg.columnlen = columnlen_new;
        }

        if (cfg.customWidth != null) {
            const customWidth_new: Record<string, number> = {};
            for (const [cstr, v] of Object.entries(cfg.customWidth)) {
                const c = Number.parseInt(cstr, 10);
                if (c < op.index) {
                    customWidth_new[c] = v;
                } else if (c === op.index) {
                    if (op.direction === 'lefttop') {
                        customWidth_new[c + count] = v;
                    } else {
                        customWidth_new[c] = v;
                    }
                } else {
                    customWidth_new[c + count] = v;
                }
            }
            newCfg.customWidth = customWidth_new;
        }

        for (const row of newData) {
            for (let i = 0; i < count; i += 1) row.splice(insertAt, 0, null);
        }
    }

    newTarget.config = newCfg;

    if (target.luckysheet_conditionformat_save != null) {
        newTarget.luckysheet_conditionformat_save = target.luckysheet_conditionformat_save.map((cf) => {
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

    let result: Sheet[] = [...sheets.slice(0, targetIndex), newTarget, ...sheets.slice(targetIndex + 1)];
    result = shiftFormulasAcrossSheets(result, op.type, op.direction, op.index, count, 'add');
    return result;
}

function applyDelete(sheets: Sheet[], targetIndex: number, op: Extract<RowColOp, { mode: 'delete' }>): Sheet[] {
    const target = sheets[targetIndex];
    const data = target.data;
    if (!data) return sheets;

    const cfg = (target.config ?? {}) as ExtendedSheetConfig;

    if (op.type === 'row' && cfg.rowReadOnly) {
        for (let i = op.start; i <= op.end; i += 1) {
            if (cfg.rowReadOnly[i]) throw new Error('readOnly');
        }
    }
    if (op.type === 'column' && cfg.colReadOnly) {
        for (let i = op.start; i <= op.end; i += 1) {
            if (cfg.colReadOnly[i]) throw new Error('readOnly');
        }
    }

    const newTarget = cloneDeep(target);
    const newCfg = (newTarget.config ?? {}) as ExtendedSheetConfig;
    const newData = newTarget.data!;
    const removeCount = op.end - op.start + 1;

    newCfg.merge = shiftMergeForDelete(cfg, op.type, op.start, removeCount);

    if (op.type === 'row') {
        if (cfg.rowhidden != null) {
            const rowhidden_new: Record<string, number> = {};
            for (const [rstr, v] of Object.entries(cfg.rowhidden)) {
                const r = Number.parseInt(rstr, 10);
                if (r < op.start) {
                    rowhidden_new[r] = v;
                } else if (r > op.end) {
                    rowhidden_new[r - removeCount] = v;
                }
            }
            newCfg.rowhidden = rowhidden_new;
        }

        if (cfg.rowlen != null) {
            const rowlen_new: Record<string, number> = {};
            for (const [rstr, v] of Object.entries(cfg.rowlen)) {
                const r = Number.parseInt(rstr, 10);
                if (r < op.start) {
                    rowlen_new[r] = v;
                } else if (r > op.end) {
                    rowlen_new[r - removeCount] = v;
                }
            }
            newCfg.rowlen = rowlen_new;
        }

        if (cfg.customHeight != null) {
            const customHeight_new: Record<string, number> = {};
            for (const [rstr, v] of Object.entries(cfg.customHeight)) {
                const r = Number.parseInt(rstr, 10);
                if (r < op.start) {
                    customHeight_new[r] = v;
                } else if (r > op.end) {
                    customHeight_new[r - removeCount] = v;
                }
            }
            newCfg.customHeight = customHeight_new;
        }

        newData.splice(op.start, removeCount);
    } else {
        if (cfg.colhidden != null) {
            const colhidden_new: Record<string, number> = {};
            for (const [cstr, v] of Object.entries(cfg.colhidden)) {
                const c = Number.parseInt(cstr, 10);
                if (c < op.start) {
                    colhidden_new[c] = v;
                } else if (c > op.end) {
                    colhidden_new[c - removeCount] = v;
                }
            }
            newCfg.colhidden = colhidden_new;
        }

        if (cfg.columnlen != null) {
            const columnlen_new: Record<string, number> = {};
            for (const [cstr, v] of Object.entries(cfg.columnlen)) {
                const c = Number.parseInt(cstr, 10);
                if (c < op.start) {
                    columnlen_new[c] = v;
                } else if (c > op.end) {
                    columnlen_new[c - removeCount] = v;
                }
            }
            newCfg.columnlen = columnlen_new;
        }

        if (cfg.customWidth != null) {
            const customWidth_new: Record<string, number> = {};
            for (const [cstr, v] of Object.entries(cfg.customWidth)) {
                const c = Number.parseInt(cstr, 10);
                if (c < op.start) {
                    customWidth_new[c] = v;
                } else if (c > op.end) {
                    customWidth_new[c - removeCount] = v;
                }
            }
            newCfg.customWidth = customWidth_new;
        }

        for (const row of newData) row.splice(op.start, removeCount);
    }

    newTarget.config = newCfg;

    if (target.luckysheet_conditionformat_save != null) {
        const newCFarr = [];
        for (const cf of target.luckysheet_conditionformat_save) {
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
        newTarget.luckysheet_conditionformat_save = newCFarr;
    }

    let result: Sheet[] = [...sheets.slice(0, targetIndex), newTarget, ...sheets.slice(targetIndex + 1)];
    result = shiftFormulasAcrossSheets(result, op.type, null, op.start, removeCount, 'del');
    return result;
}
