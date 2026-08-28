import { cloneDeep, isEmpty } from 'es-toolkit/compat';
import { type Context, editableConfig } from '../context';
import type { Cell, CellMatrix, MergeCell, Range } from '../types';
import { getSheetIndex } from '../utils';
import { isInlineStringCT } from './inline-string';

// Restore the cells covered by merges intersecting the range: the anchor cell's
// content is stashed in `fv` and re-applied, the other members are cleared.
function unmergeRange(d: CellMatrix, merge: Record<string, MergeCell>, r1: number, r2: number, c1: number, c2: number) {
    const fv: Record<string, Cell> = {};

    for (let r = r1; r <= r2; r += 1) {
        for (let c = c1; c <= c2; c += 1) {
            const cell = d[r][c];

            if (cell != null && cell.mc != null) {
                const mc_r = cell.mc.r;
                const mc_c = cell.mc.c;

                if ('rs' in cell.mc) {
                    delete cell.mc;
                    delete merge[`${mc_r}_${mc_c}`];

                    fv[`${mc_r}_${mc_c}`] = cloneDeep(cell) || {};
                } else {
                    const cell_clone = cloneDeep(fv[`${mc_r}_${mc_c}`]);

                    delete cell_clone.v;
                    delete cell_clone.m;
                    delete cell_clone.ct;
                    delete cell_clone.f;

                    d[r][c] = cell_clone;
                }
            }
        }
    }
}

export function mergeCells(ctx: Context, sheetId: string, ranges: Range, type: string) {
    const idx = getSheetIndex(ctx, sheetId);
    if (idx == null) return;

    const sheet = ctx.sheets[idx];

    const cfg = editableConfig(ctx, sheet);
    if (cfg.merge == null) {
        cfg.merge = {};
    }

    const d = sheet.data!;

    if (type === 'merge-cancel') {
        for (let i = 0; i < ranges.length; i += 1) {
            const range = ranges[i];
            const r1 = range.row[0];
            const r2 = range.row[1];
            const c1 = range.column[0];
            const c2 = range.column[1];

            if (r1 === r2 && c1 === c2) {
                continue;
            }

            unmergeRange(d, cfg.merge, r1, r2, c1, c2);
        }
    } else {
        let isHasMc = false; // Whether the selection contains merged cells

        for (let i = 0; i < ranges.length; i += 1) {
            const range = ranges[i];
            const r1 = range.row[0];
            const r2 = range.row[1];
            const c1 = range.column[0];
            const c2 = range.column[1];

            for (let r = r1; r <= r2; r += 1) {
                for (let c = c1; c <= c2; c += 1) {
                    const cell = d[r][c];

                    if (cell?.mc) {
                        isHasMc = true;
                        break;
                    }
                }
            }
        }

        if (isHasMc) {
            // Selection has merged cells (all selections will unmerge)
            for (let i = 0; i < ranges.length; i += 1) {
                const range = ranges[i];
                const r1 = range.row[0];
                const r2 = range.row[1];
                const c1 = range.column[0];
                const c2 = range.column[1];

                if (r1 === r2 && c1 === c2) {
                    continue;
                }

                unmergeRange(d, cfg.merge, r1, r2, c1, c2);
            }
        } else {
            for (let i = 0; i < ranges.length; i += 1) {
                const range = ranges[i];
                const r1 = range.row[0];
                const r2 = range.row[1];
                const c1 = range.column[0];
                const c2 = range.column[1];

                if (r1 === r2 && c1 === c2) {
                    continue;
                }

                if (type === 'merge-all') {
                    let fv = {};
                    let isfirst = false;

                    for (let r = r1; r <= r2; r += 1) {
                        for (let c = c1; c <= c2; c += 1) {
                            const cell = d[r][c];

                            if (
                                cell != null &&
                                (isInlineStringCT(cell.ct) || !isEmpty(cell.v) || cell.f != null) &&
                                !isfirst
                            ) {
                                fv = cloneDeep(cell) || {};
                                isfirst = true;
                            }

                            d[r][c] = { mc: { r: r1, c: c1 } };
                        }
                    }

                    d[r1][c1] = fv;
                    const a = d[r1][c1];
                    if (!a) return;
                    a.mc = { r: r1, c: c1, rs: r2 - r1 + 1, cs: c2 - c1 + 1 };

                    cfg.merge[`${r1}_${c1}`] = {
                        r: r1,
                        c: c1,
                        rs: r2 - r1 + 1,
                        cs: c2 - c1 + 1,
                    };
                } else if (type === 'merge-vertical') {
                    for (let c = c1; c <= c2; c += 1) {
                        let fv = {};
                        let isfirst = false;

                        for (let r = r1; r <= r2; r += 1) {
                            const cell = d[r][c];

                            if (cell != null && (!isEmpty(cell.v) || cell.f != null) && !isfirst) {
                                fv = cloneDeep(cell) || {};
                                isfirst = true;
                            }

                            d[r][c] = { mc: { r: r1, c } };
                        }

                        d[r1][c] = fv;
                        const a = d[r1][c];
                        if (!a) return;
                        a.mc = { r: r1, c, rs: r2 - r1 + 1, cs: 1 };

                        cfg.merge[`${r1}_${c}`] = {
                            r: r1,
                            c,
                            rs: r2 - r1 + 1,
                            cs: 1,
                        };
                    }
                } else if (type === 'merge-horizontal') {
                    for (let r = r1; r <= r2; r += 1) {
                        let fv = {};
                        let isfirst = false;

                        for (let c = c1; c <= c2; c += 1) {
                            const cell = d[r][c];

                            if (cell != null && (!isEmpty(cell.v) || cell.f != null) && !isfirst) {
                                fv = cloneDeep(cell) || {};
                                isfirst = true;
                            }

                            d[r][c] = { mc: { r, c: c1 } };
                        }

                        d[r][c1] = fv;
                        const a = d[r][c1];
                        if (!a) return;
                        a.mc = { r, c: c1, rs: 1, cs: c2 - c1 + 1 };

                        cfg.merge[`${r}_${c1}`] = {
                            r,
                            c: c1,
                            rs: 1,
                            cs: c2 - c1 + 1,
                        };
                    }
                }
            }
        }
    }
}
