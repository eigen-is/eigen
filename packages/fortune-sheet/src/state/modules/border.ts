import type { MergeCell } from '@workspace/lib/sheets';
import { isEmpty, isNil, isPlainObject } from 'es-toolkit/compat';
import type { Cell, CellMatrix } from '../../engine/types';
import { type Context, getFlowdata } from '../context';
import type { SheetConfig } from '../types';
import { getSheetIndex } from '../utils';

// Side of a computed cell border. Style accepts string because the FE toolbar
// pushes `'1'..'13'` into RangeBorderInfo.style; the cell variant in
// CellBorderInfo is `number`. Canvas painter normalises via `.toString()`.
type ComputedBorderSide = { color: string; style: number | string };
type ComputedBorderEntry = {
    s?: ComputedBorderSide | null;
    l?: ComputedBorderSide | null;
    r?: ComputedBorderSide | null;
    t?: ComputedBorderSide | null;
    b?: ComputedBorderSide | null;
};
type ComputedBorderMap = Record<string, ComputedBorderEntry>;

// Internally the entries are `ComputedBorderEntry`; the return type stays
// loose because paste.ts / selection.ts / moveCells.ts / dropCell.ts read the
// map via repeated template-literal indexing where TS cannot prove non-null
// after `if (m[k].l)` narrowing. Tighten when those callers are cleaned up
// under TODO #1.
export function getBorderInfoComputeRange(
    ctx: Context,
    dataset_row_st: number,
    dataset_row_ed: number,
    dataset_col_st: number,
    dataset_col_ed: number,
    sheetId?: string,
    // biome-ignore lint/suspicious/noExplicitAny: see preceding comment
): Record<string, any> {
    const borderInfoCompute: ComputedBorderMap = {};
    const flowdata = getFlowdata(ctx);

    let cfg: SheetConfig | undefined;
    let data: CellMatrix | null | undefined;
    if (!sheetId) {
        cfg = ctx.config;
        data = flowdata;
    } else {
        const index = getSheetIndex(ctx, sheetId);
        if (isNil(index)) return borderInfoCompute;
        cfg = ctx.luckysheetfile[index].config;
        data = ctx.luckysheetfile[index].data;
    }
    if (!data || !cfg) return borderInfoCompute;

    const borderInfo = cfg.borderInfo ?? [];

    if (isEmpty(borderInfo)) return borderInfoCompute;

    for (let i = 0; i < borderInfo.length; i += 1) {
        const entry = borderInfo[i];

        if (entry.rangeType === 'range') {
            const { borderType, color: borderColor, style: borderStyle, range: borderRange } = entry;

            for (let j = 0; j < borderRange.length; j += 1) {
                let bd_r1 = borderRange[j].row[0];
                let bd_r2 = borderRange[j].row[1];
                let bd_c1 = borderRange[j].column[0];
                let bd_c2 = borderRange[j].column[1];

                if (bd_r1 < dataset_row_st) {
                    bd_r1 = dataset_row_st;
                }

                if (bd_r2 > dataset_row_ed) {
                    bd_r2 = dataset_row_ed;
                }

                if (bd_c1 < dataset_col_st) {
                    bd_c1 = dataset_col_st;
                }

                if (bd_c2 > dataset_col_ed) {
                    bd_c2 = dataset_col_ed;
                }

                if (borderType === 'border-slash') {
                    const bd_r = borderRange[0].row_focus;
                    const bd_c = borderRange[0].column_focus;
                    if (bd_r == null || bd_c == null) continue;
                    if (cfg.rowhidden?.[bd_r] != null) continue;
                    if (bd_c < dataset_col_st || bd_c > dataset_col_ed) continue;
                    if (bd_r < dataset_row_st || bd_r > dataset_row_ed) continue;
                    if (borderInfoCompute[`${bd_r}_${bd_c}`] === undefined) {
                        borderInfoCompute[`${bd_r}_${bd_c}`] = {};
                    }
                    borderInfoCompute[`${bd_r}_${bd_c}`].s = {
                        color: borderColor,
                        style: borderStyle,
                    };
                }
                if (borderType === 'border-left') {
                    for (let bd_r = bd_r1; bd_r <= bd_r2; bd_r += 1) {
                        if (!isNil(cfg.rowhidden) && !isNil(cfg.rowhidden[bd_r])) {
                            continue;
                        }

                        if (borderInfoCompute[`${bd_r}_${bd_c1}`] === undefined) {
                            borderInfoCompute[`${bd_r}_${bd_c1}`] = {};
                        }

                        borderInfoCompute[`${bd_r}_${bd_c1}`].l = {
                            color: borderColor,
                            style: borderStyle,
                        };

                        const bd_c_left = bd_c1 - 1;

                        if (bd_c_left >= 0 && borderInfoCompute[`${bd_r}_${bd_c_left}`]) {
                            if (!isNil(data[bd_r]?.[bd_c_left]?.mc)) {
                                const cell_left = data[bd_r][bd_c_left];

                                const mc = cfg.merge?.[`${cell_left?.mc?.r}_${cell_left?.mc?.c}`];

                                if (mc && mc.c + mc.cs - 1 === bd_c_left) {
                                    borderInfoCompute[`${bd_r}_${bd_c_left}`].r = {
                                        color: borderColor,
                                        style: borderStyle,
                                    };
                                }
                            } else {
                                borderInfoCompute[`${bd_r}_${bd_c_left}`].r = {
                                    color: borderColor,
                                    style: borderStyle,
                                };
                            }
                        }

                        const mc = cfg.merge || {};
                        Object.keys(mc).forEach((key) => {
                            const { c, r, cs, rs } = mc[key];
                            if (bd_c1 <= c + cs - 1 && bd_c1 > c && bd_r >= r && bd_r <= r + rs - 1) {
                                borderInfoCompute[`${bd_r}_${bd_c1}`].l = null;
                            }
                        });
                    }
                } else if (borderType === 'border-right') {
                    for (let bd_r = bd_r1; bd_r <= bd_r2; bd_r += 1) {
                        if (!isNil(cfg.rowhidden) && !isNil(cfg.rowhidden[bd_r])) {
                            continue;
                        }

                        if (borderInfoCompute[`${bd_r}_${bd_c2}`] === undefined) {
                            borderInfoCompute[`${bd_r}_${bd_c2}`] = {};
                        }

                        borderInfoCompute[`${bd_r}_${bd_c2}`].r = {
                            color: borderColor,
                            style: borderStyle,
                        };

                        const bd_c_right = bd_c2 + 1;

                        if (bd_c_right < data[0].length && borderInfoCompute[`${bd_r}_${bd_c_right}`]) {
                            if (!isNil(data[bd_r]?.[bd_c_right]?.mc)) {
                                const cell_right = data[bd_r][bd_c_right];

                                const mc = cfg.merge?.[`${cell_right?.mc?.r}_${cell_right?.mc?.c}`];

                                if (mc && mc.c === bd_c_right) {
                                    borderInfoCompute[`${bd_r}_${bd_c_right}`].l = {
                                        color: borderColor,
                                        style: borderStyle,
                                    };
                                }
                            } else {
                                borderInfoCompute[`${bd_r}_${bd_c_right}`].l = {
                                    color: borderColor,
                                    style: borderStyle,
                                };
                            }
                        }
                        const mc = cfg.merge || {};
                        Object.keys(mc).forEach((key) => {
                            const { c, r, cs, rs } = mc[key];
                            if (bd_c2 < c + cs - 1 && bd_c2 >= c && bd_r >= r && bd_r <= r + rs - 1) {
                                borderInfoCompute[`${bd_r}_${bd_c2}`].r = null;
                            }
                        });
                    }
                } else if (borderType === 'border-top') {
                    if (!isNil(cfg.rowhidden) && !isNil(cfg.rowhidden[bd_r1])) {
                        continue;
                    }

                    for (let bd_c = bd_c1; bd_c <= bd_c2; bd_c += 1) {
                        if (borderInfoCompute[`${bd_r1}_${bd_c}`] === undefined) {
                            borderInfoCompute[`${bd_r1}_${bd_c}`] = {};
                        }

                        borderInfoCompute[`${bd_r1}_${bd_c}`].t = {
                            color: borderColor,
                            style: borderStyle,
                        };

                        const bd_r_top = bd_r1 - 1;

                        if (bd_r_top >= 0 && borderInfoCompute[`${bd_r_top}_${bd_c}`]) {
                            if (!isNil(data[bd_r_top]?.[bd_c]?.mc)) {
                                const cell_top = data[bd_r_top][bd_c];

                                const mc = cfg.merge?.[`${cell_top?.mc?.r}_${cell_top?.mc?.c}`];

                                if (mc && mc.r + mc.rs - 1 === bd_r_top) {
                                    borderInfoCompute[`${bd_r_top}_${bd_c}`].b = {
                                        color: borderColor,
                                        style: borderStyle,
                                    };
                                }
                            } else {
                                borderInfoCompute[`${bd_r_top}_${bd_c}`].b = {
                                    color: borderColor,
                                    style: borderStyle,
                                };
                            }
                        }

                        const mc = cfg.merge || {};
                        Object.keys(mc).forEach((key) => {
                            const { c, r, cs, rs } = mc[key];
                            if (bd_r1 <= r + rs - 1 && bd_r1 > r && bd_c >= c && bd_c <= c + cs - 1) {
                                borderInfoCompute[`${bd_r1}_${bd_c}`].t = null;
                            }
                        });
                    }
                } else if (borderType === 'border-bottom') {
                    if (!isNil(cfg.rowhidden) && !isNil(cfg.rowhidden[bd_r2])) {
                        continue;
                    }

                    for (let bd_c = bd_c1; bd_c <= bd_c2; bd_c += 1) {
                        if (borderInfoCompute[`${bd_r2}_${bd_c}`] === undefined) {
                            borderInfoCompute[`${bd_r2}_${bd_c}`] = {};
                        }

                        borderInfoCompute[`${bd_r2}_${bd_c}`].b = {
                            color: borderColor,
                            style: borderStyle,
                        };

                        const bd_r_bottom = bd_r2 + 1;

                        if (bd_r_bottom < data.length && borderInfoCompute[`${bd_r_bottom}_${bd_c}`]) {
                            if (!isNil(data[bd_r_bottom]?.[bd_c]?.mc)) {
                                const cell_bottom = data[bd_r_bottom][bd_c];

                                const mc = cfg.merge?.[`${cell_bottom?.mc?.r}_${cell_bottom?.mc?.c}`];

                                if (mc?.r === bd_r_bottom) {
                                    borderInfoCompute[`${bd_r_bottom}_${bd_c}`].t = {
                                        color: borderColor,
                                        style: borderStyle,
                                    };
                                }
                            } else {
                                borderInfoCompute[`${bd_r_bottom}_${bd_c}`].t = {
                                    color: borderColor,
                                    style: borderStyle,
                                };
                            }
                        }

                        const mc = cfg.merge || {};
                        Object.keys(mc).forEach((key) => {
                            const { c, r, cs, rs } = mc[key];
                            if (bd_r2 < r + rs - 1 && bd_r2 >= r && bd_c >= c && bd_c <= c + cs - 1) {
                                borderInfoCompute[`${bd_r2}_${bd_c}`].b = null;
                            }
                        });
                    }
                } else if (borderType === 'border-all') {
                    for (let bd_r = bd_r1; bd_r <= bd_r2; bd_r += 1) {
                        if (!isNil(cfg.rowhidden) && !isNil(cfg.rowhidden[bd_r])) {
                            continue;
                        }

                        for (let bd_c = bd_c1; bd_c <= bd_c2; bd_c += 1) {
                            if (!isNil(data[bd_r]?.[bd_c]?.mc)) {
                                const cell: Cell | null = data[bd_r][bd_c];

                                const mc: MergeCell | undefined = cfg.merge?.[`${cell?.mc?.r}_${cell?.mc?.c}`];

                                if (mc?.r === bd_r) {
                                    if (borderInfoCompute[`${bd_r}_${bd_c}`] === undefined) {
                                        borderInfoCompute[`${bd_r}_${bd_c}`] = {};
                                    }

                                    borderInfoCompute[`${bd_r}_${bd_c}`].t = {
                                        color: borderColor,
                                        style: borderStyle,
                                    };
                                }

                                if (mc && mc.r + mc.rs - 1 === bd_r) {
                                    if (borderInfoCompute[`${bd_r}_${bd_c}`] === undefined) {
                                        borderInfoCompute[`${bd_r}_${bd_c}`] = {};
                                    }

                                    borderInfoCompute[`${bd_r}_${bd_c}`].b = {
                                        color: borderColor,
                                        style: borderStyle,
                                    };
                                }

                                if (mc?.c === bd_c) {
                                    if (borderInfoCompute[`${bd_r}_${bd_c}`] === undefined) {
                                        borderInfoCompute[`${bd_r}_${bd_c}`] = {};
                                    }

                                    borderInfoCompute[`${bd_r}_${bd_c}`].l = {
                                        color: borderColor,
                                        style: borderStyle,
                                    };
                                }

                                if (mc && mc.c + mc.cs - 1 === bd_c) {
                                    if (borderInfoCompute[`${bd_r}_${bd_c}`] === undefined) {
                                        borderInfoCompute[`${bd_r}_${bd_c}`] = {};
                                    }

                                    borderInfoCompute[`${bd_r}_${bd_c}`].r = {
                                        color: borderColor,
                                        style: borderStyle,
                                    };
                                }
                            } else {
                                if (borderInfoCompute[`${bd_r}_${bd_c}`] === undefined) {
                                    borderInfoCompute[`${bd_r}_${bd_c}`] = {};
                                }

                                borderInfoCompute[`${bd_r}_${bd_c}`].l = {
                                    color: borderColor,
                                    style: borderStyle,
                                };
                                borderInfoCompute[`${bd_r}_${bd_c}`].r = {
                                    color: borderColor,
                                    style: borderStyle,
                                };
                                borderInfoCompute[`${bd_r}_${bd_c}`].t = {
                                    color: borderColor,
                                    style: borderStyle,
                                };
                                borderInfoCompute[`${bd_r}_${bd_c}`].b = {
                                    color: borderColor,
                                    style: borderStyle,
                                };
                            }

                            if (bd_r === bd_r1) {
                                const bd_r_top = bd_r1 - 1;

                                if (bd_r_top >= 0 && borderInfoCompute[`${bd_r_top}_${bd_c}`]) {
                                    if (!isNil(data[bd_r_top]?.[bd_c]?.mc)) {
                                        const cell_top = data[bd_r_top][bd_c];

                                        const mc = cfg.merge?.[`${cell_top?.mc?.r}_${cell_top?.mc?.c}`];

                                        if (mc && mc.r + mc.rs - 1 === bd_r_top) {
                                            borderInfoCompute[`${bd_r_top}_${bd_c}`].b = {
                                                color: borderColor,
                                                style: borderStyle,
                                            };
                                        }
                                    } else {
                                        borderInfoCompute[`${bd_r_top}_${bd_c}`].b = {
                                            color: borderColor,
                                            style: borderStyle,
                                        };
                                    }
                                }
                            }

                            if (bd_r === bd_r2) {
                                const bd_r_bottom = bd_r2 + 1;

                                if (bd_r_bottom < data.length && borderInfoCompute[`${bd_r_bottom}_${bd_c}`]) {
                                    if (!isNil(data[bd_r_bottom]?.[bd_c]?.mc)) {
                                        const cell_bottom = data[bd_r_bottom][bd_c];

                                        const mc = cfg.merge?.[`${cell_bottom?.mc?.r}_${cell_bottom?.mc?.c}`];

                                        if (mc?.r === bd_r_bottom) {
                                            borderInfoCompute[`${bd_r_bottom}_${bd_c}`].t = {
                                                color: borderColor,
                                                style: borderStyle,
                                            };
                                        }
                                    } else {
                                        borderInfoCompute[`${bd_r_bottom}_${bd_c}`].t = {
                                            color: borderColor,
                                            style: borderStyle,
                                        };
                                    }
                                }
                            }

                            if (bd_c === bd_c1) {
                                const bd_c_left = bd_c1 - 1;

                                if (bd_c_left >= 0 && borderInfoCompute[`${bd_r}_${bd_c_left}`]) {
                                    if (!isNil(data[bd_r]?.[bd_c_left]?.mc)) {
                                        const cell_left = data[bd_r][bd_c_left];

                                        const mc = cfg.merge?.[`${cell_left?.mc?.r}_${cell_left?.mc?.c}`];

                                        if (mc && mc.c + mc.cs - 1 === bd_c_left) {
                                            borderInfoCompute[`${bd_r}_${bd_c_left}`].r = {
                                                color: borderColor,
                                                style: borderStyle,
                                            };
                                        }
                                    } else {
                                        borderInfoCompute[`${bd_r}_${bd_c_left}`].r = {
                                            color: borderColor,
                                            style: borderStyle,
                                        };
                                    }
                                }
                            }

                            if (bd_c === bd_c2) {
                                const bd_c_right = bd_c2 + 1;

                                if (bd_c_right < data[0].length && borderInfoCompute[`${bd_r}_${bd_c_right}`]) {
                                    if (!isNil(data[bd_r]?.[bd_c_right]?.mc)) {
                                        const cell_right = data[bd_r][bd_c_right];

                                        const mc = cfg.merge?.[`${cell_right?.mc?.r}_${cell_right?.mc?.c}`];

                                        if (mc?.c === bd_c_right) {
                                            borderInfoCompute[`${bd_r}_${bd_c_right}`].l = {
                                                color: borderColor,
                                                style: borderStyle,
                                            };
                                        }
                                    } else {
                                        borderInfoCompute[`${bd_r}_${bd_c_right}`].l = {
                                            color: borderColor,
                                            style: borderStyle,
                                        };
                                    }
                                }
                            }
                        }
                    }
                } else if (borderType === 'border-outside') {
                    for (let bd_r = bd_r1; bd_r <= bd_r2; bd_r += 1) {
                        if (!isNil(cfg.rowhidden) && !isNil(cfg.rowhidden[bd_r])) {
                            continue;
                        }

                        for (let bd_c = bd_c1; bd_c <= bd_c2; bd_c += 1) {
                            if (!(bd_r === bd_r1 || bd_r === bd_r2 || bd_c === bd_c1 || bd_c === bd_c2)) {
                                continue;
                            }

                            if (bd_r === bd_r1) {
                                if (borderInfoCompute[`${bd_r}_${bd_c}`] === undefined) {
                                    borderInfoCompute[`${bd_r}_${bd_c}`] = {};
                                }

                                borderInfoCompute[`${bd_r}_${bd_c}`].t = {
                                    color: borderColor,
                                    style: borderStyle,
                                };

                                const bd_r_top = bd_r1 - 1;

                                if (bd_r_top >= 0 && borderInfoCompute[`${bd_r_top}_${bd_c}`]) {
                                    if (!isNil(data[bd_r_top]?.[bd_c]?.mc)) {
                                        const cell_top = data[bd_r_top][bd_c];

                                        const mc = cfg.merge?.[`${cell_top?.mc?.r}_${cell_top?.mc?.c}`];

                                        if (mc && mc.r + mc.rs - 1 === bd_r_top) {
                                            borderInfoCompute[`${bd_r_top}_${bd_c}`].b = {
                                                color: borderColor,
                                                style: borderStyle,
                                            };
                                        }
                                    } else {
                                        borderInfoCompute[`${bd_r_top}_${bd_c}`].b = {
                                            color: borderColor,
                                            style: borderStyle,
                                        };
                                    }
                                }
                            }

                            if (bd_r === bd_r2) {
                                if (borderInfoCompute[`${bd_r}_${bd_c}`] === undefined) {
                                    borderInfoCompute[`${bd_r}_${bd_c}`] = {};
                                }

                                borderInfoCompute[`${bd_r}_${bd_c}`].b = {
                                    color: borderColor,
                                    style: borderStyle,
                                };

                                const bd_r_bottom = bd_r2 + 1;

                                if (bd_r_bottom < data.length && borderInfoCompute[`${bd_r_bottom}_${bd_c}`]) {
                                    if (!isNil(data[bd_r_bottom]?.[bd_c]?.mc)) {
                                        const cell_bottom = data[bd_r_bottom][bd_c];

                                        const mc = cfg.merge?.[`${cell_bottom?.mc?.r}_${cell_bottom?.mc?.c}`];

                                        if (mc?.r === bd_r_bottom) {
                                            borderInfoCompute[`${bd_r_bottom}_${bd_c}`].t = {
                                                color: borderColor,
                                                style: borderStyle,
                                            };
                                        }
                                    } else {
                                        borderInfoCompute[`${bd_r_bottom}_${bd_c}`].t = {
                                            color: borderColor,
                                            style: borderStyle,
                                        };
                                    }
                                }
                            }

                            if (bd_c === bd_c1) {
                                if (borderInfoCompute[`${bd_r}_${bd_c}`] === undefined) {
                                    borderInfoCompute[`${bd_r}_${bd_c}`] = {};
                                }

                                borderInfoCompute[`${bd_r}_${bd_c}`].l = {
                                    color: borderColor,
                                    style: borderStyle,
                                };

                                const bd_c_left = bd_c1 - 1;

                                if (bd_c_left >= 0 && borderInfoCompute[`${bd_r}_${bd_c_left}`]) {
                                    if (!isNil(data[bd_r]?.[bd_c_left]?.mc)) {
                                        const cell_left = data[bd_r][bd_c_left];

                                        const mc = cfg.merge?.[`${cell_left?.mc?.r}_${cell_left?.mc?.c}`];

                                        if (mc && mc.c + mc.cs - 1 === bd_c_left) {
                                            borderInfoCompute[`${bd_r}_${bd_c_left}`].r = {
                                                color: borderColor,
                                                style: borderStyle,
                                            };
                                        }
                                    } else {
                                        borderInfoCompute[`${bd_r}_${bd_c_left}`].r = {
                                            color: borderColor,
                                            style: borderStyle,
                                        };
                                    }
                                }
                            }

                            if (bd_c === bd_c2) {
                                if (borderInfoCompute[`${bd_r}_${bd_c}`] === undefined) {
                                    borderInfoCompute[`${bd_r}_${bd_c}`] = {};
                                }

                                borderInfoCompute[`${bd_r}_${bd_c}`].r = {
                                    color: borderColor,
                                    style: borderStyle,
                                };

                                const bd_c_right = bd_c2 + 1;

                                if (bd_c_right < data[0].length && borderInfoCompute[`${bd_r}_${bd_c_right}`]) {
                                    if (!isNil(data[bd_r]?.[bd_c_right]?.mc)) {
                                        const cell_right = data[bd_r][bd_c_right];

                                        const mc = cfg.merge?.[`${cell_right?.mc?.r}_${cell_right?.mc?.c}`];

                                        if (mc?.c === bd_c_right) {
                                            borderInfoCompute[`${bd_r}_${bd_c_right}`].l = {
                                                color: borderColor,
                                                style: borderStyle,
                                            };
                                        }
                                    } else {
                                        borderInfoCompute[`${bd_r}_${bd_c_right}`].l = {
                                            color: borderColor,
                                            style: borderStyle,
                                        };
                                    }
                                }
                            }
                        }
                    }
                } else if (borderType === 'border-inside') {
                    for (let bd_r = bd_r1; bd_r <= bd_r2; bd_r += 1) {
                        if (!isNil(cfg.rowhidden) && !isNil(cfg.rowhidden[bd_r])) {
                            continue;
                        }

                        for (let bd_c = bd_c1; bd_c <= bd_c2; bd_c += 1) {
                            if (bd_r === bd_r1 && bd_c === bd_c1) {
                                if (!isNil(data[bd_r]?.[bd_c]?.mc)) {
                                } else {
                                    if (borderInfoCompute[`${bd_r}_${bd_c}`] === undefined) {
                                        borderInfoCompute[`${bd_r}_${bd_c}`] = {};
                                    }
                                }
                            } else if (bd_r === bd_r2 && bd_c === bd_c1) {
                                if (!isNil(data[bd_r]?.[bd_c]?.mc)) {
                                } else {
                                    if (borderInfoCompute[`${bd_r}_${bd_c}`] === undefined) {
                                        borderInfoCompute[`${bd_r}_${bd_c}`] = {};
                                    }
                                    borderInfoCompute[`${bd_r}_${bd_c}`].t = {
                                        color: borderColor,
                                        style: borderStyle,
                                    };
                                }
                            } else if (bd_r === bd_r1 && bd_c === bd_c2) {
                                if (!isNil(data[bd_r]?.[bd_c]?.mc)) {
                                } else {
                                    if (borderInfoCompute[`${bd_r}_${bd_c}`] === undefined) {
                                        borderInfoCompute[`${bd_r}_${bd_c}`] = {};
                                    }

                                    borderInfoCompute[`${bd_r}_${bd_c}`].l = {
                                        color: borderColor,
                                        style: borderStyle,
                                    };
                                }
                            } else if (bd_r === bd_r2 && bd_c === bd_c2) {
                                if (!isNil(data[bd_r]?.[bd_c]?.mc)) {
                                } else {
                                    if (borderInfoCompute[`${bd_r}_${bd_c}`] === undefined) {
                                        borderInfoCompute[`${bd_r}_${bd_c}`] = {};
                                    }

                                    borderInfoCompute[`${bd_r}_${bd_c}`].l = {
                                        color: borderColor,
                                        style: borderStyle,
                                    };
                                    borderInfoCompute[`${bd_r}_${bd_c}`].t = {
                                        color: borderColor,
                                        style: borderStyle,
                                    };
                                }
                            } else if (bd_r === bd_r1) {
                                if (!isNil(data[bd_r]?.[bd_c]?.mc)) {
                                    const cell = data[bd_r][bd_c];

                                    const mc = cfg.merge?.[`${cell?.mc?.r}_${cell?.mc?.c}`];

                                    if (mc?.c === bd_c) {
                                        if (borderInfoCompute[`${bd_r}_${bd_c}`] === undefined) {
                                            borderInfoCompute[`${bd_r}_${bd_c}`] = {};
                                        }

                                        borderInfoCompute[`${bd_r}_${bd_c}`].l = {
                                            color: borderColor,
                                            style: borderStyle,
                                        };
                                    } else if (mc && mc.c + mc.cs - 1 === bd_c) {
                                        if (borderInfoCompute[`${bd_r}_${bd_c}`] === undefined) {
                                            borderInfoCompute[`${bd_r}_${bd_c}`] = {};
                                        }
                                    }
                                } else {
                                    if (borderInfoCompute[`${bd_r}_${bd_c}`] === undefined) {
                                        borderInfoCompute[`${bd_r}_${bd_c}`] = {};
                                    }

                                    borderInfoCompute[`${bd_r}_${bd_c}`].l = {
                                        color: borderColor,
                                        style: borderStyle,
                                    };
                                }
                            } else if (bd_r === bd_r2) {
                                if (!isNil(data[bd_r]?.[bd_c]?.mc)) {
                                    const cell = data[bd_r][bd_c];

                                    const mc = cfg.merge?.[`${cell?.mc?.r}_${cell?.mc?.c}`];

                                    if (mc?.c === bd_c) {
                                        if (borderInfoCompute[`${bd_r}_${bd_c}`] === undefined) {
                                            borderInfoCompute[`${bd_r}_${bd_c}`] = {};
                                        }

                                        borderInfoCompute[`${bd_r}_${bd_c}`].l = {
                                            color: borderColor,
                                            style: borderStyle,
                                        };
                                    } else if (mc && mc.c + mc.cs - 1 === bd_c) {
                                        if (borderInfoCompute[`${bd_r}_${bd_c}`] === undefined) {
                                            borderInfoCompute[`${bd_r}_${bd_c}`] = {};
                                        }
                                    }
                                } else {
                                    if (borderInfoCompute[`${bd_r}_${bd_c}`] === undefined) {
                                        borderInfoCompute[`${bd_r}_${bd_c}`] = {};
                                    }

                                    borderInfoCompute[`${bd_r}_${bd_c}`].l = {
                                        color: borderColor,
                                        style: borderStyle,
                                    };
                                    borderInfoCompute[`${bd_r}_${bd_c}`].t = {
                                        color: borderColor,
                                        style: borderStyle,
                                    };
                                }
                            } else if (bd_c === bd_c1) {
                                if (!isNil(data[bd_r]?.[bd_c]?.mc)) {
                                    const cell = data[bd_r][bd_c];

                                    const mc = cfg.merge?.[`${cell?.mc?.r}_${cell?.mc?.c}`];

                                    if (mc?.r === bd_r) {
                                        if (borderInfoCompute[`${bd_r}_${bd_c}`] === undefined) {
                                            borderInfoCompute[`${bd_r}_${bd_c}`] = {};
                                        }

                                        borderInfoCompute[`${bd_r}_${bd_c}`].t = {
                                            color: borderColor,
                                            style: borderStyle,
                                        };
                                    } else if (mc && mc.r + mc.rs - 1 === bd_r) {
                                        if (borderInfoCompute[`${bd_r}_${bd_c}`] === undefined) {
                                            borderInfoCompute[`${bd_r}_${bd_c}`] = {};
                                        }
                                    }
                                } else {
                                    if (borderInfoCompute[`${bd_r}_${bd_c}`] === undefined) {
                                        borderInfoCompute[`${bd_r}_${bd_c}`] = {};
                                    }
                                    borderInfoCompute[`${bd_r}_${bd_c}`].t = {
                                        color: borderColor,
                                        style: borderStyle,
                                    };
                                }
                            } else if (bd_c === bd_c2) {
                                if (!isNil(data[bd_r]?.[bd_c]?.mc)) {
                                    const cell = data[bd_r][bd_c];

                                    const mc = cfg.merge?.[`${cell?.mc?.r}_${cell?.mc?.c}`];

                                    if (mc?.r === bd_r) {
                                        if (borderInfoCompute[`${bd_r}_${bd_c}`] === undefined) {
                                            borderInfoCompute[`${bd_r}_${bd_c}`] = {};
                                        }

                                        borderInfoCompute[`${bd_r}_${bd_c}`].t = {
                                            color: borderColor,
                                            style: borderStyle,
                                        };
                                    } else if (mc && mc.r + mc.rs - 1 === bd_r) {
                                        if (borderInfoCompute[`${bd_r}_${bd_c}`] === undefined) {
                                            borderInfoCompute[`${bd_r}_${bd_c}`] = {};
                                        }
                                    }
                                } else {
                                    if (borderInfoCompute[`${bd_r}_${bd_c}`] === undefined) {
                                        borderInfoCompute[`${bd_r}_${bd_c}`] = {};
                                    }

                                    borderInfoCompute[`${bd_r}_${bd_c}`].l = {
                                        color: borderColor,
                                        style: borderStyle,
                                    };
                                    borderInfoCompute[`${bd_r}_${bd_c}`].t = {
                                        color: borderColor,
                                        style: borderStyle,
                                    };
                                }
                            } else {
                                if (!isNil(data[bd_r]?.[bd_c]?.mc)) {
                                    const cell = data[bd_r][bd_c];

                                    const mc = cfg.merge?.[`${cell?.mc?.r}_${cell?.mc?.c}`];

                                    if (mc?.r === bd_r) {
                                        if (borderInfoCompute[`${bd_r}_${bd_c}`] === undefined) {
                                            borderInfoCompute[`${bd_r}_${bd_c}`] = {};
                                        }

                                        borderInfoCompute[`${bd_r}_${bd_c}`].t = {
                                            color: borderColor,
                                            style: borderStyle,
                                        };
                                    } else if (mc && mc.r + mc.rs - 1 === bd_r) {
                                        if (borderInfoCompute[`${bd_r}_${bd_c}`] === undefined) {
                                            borderInfoCompute[`${bd_r}_${bd_c}`] = {};
                                        }
                                    }

                                    if (mc?.c === bd_c) {
                                        if (borderInfoCompute[`${bd_r}_${bd_c}`] === undefined) {
                                            borderInfoCompute[`${bd_r}_${bd_c}`] = {};
                                        }

                                        borderInfoCompute[`${bd_r}_${bd_c}`].l = {
                                            color: borderColor,
                                            style: borderStyle,
                                        };
                                    } else if (mc && mc.c + mc.cs - 1 === bd_c) {
                                        if (borderInfoCompute[`${bd_r}_${bd_c}`] === undefined) {
                                            borderInfoCompute[`${bd_r}_${bd_c}`] = {};
                                        }
                                    }
                                } else {
                                    if (borderInfoCompute[`${bd_r}_${bd_c}`] === undefined) {
                                        borderInfoCompute[`${bd_r}_${bd_c}`] = {};
                                    }

                                    borderInfoCompute[`${bd_r}_${bd_c}`].l = {
                                        color: borderColor,
                                        style: borderStyle,
                                    };
                                    borderInfoCompute[`${bd_r}_${bd_c}`].t = {
                                        color: borderColor,
                                        style: borderStyle,
                                    };
                                }
                            }
                        }
                    }
                } else if (borderType === 'border-horizontal') {
                    for (let bd_r = bd_r1; bd_r <= bd_r2; bd_r += 1) {
                        if (!isNil(cfg.rowhidden) && !isNil(cfg.rowhidden[bd_r])) {
                            continue;
                        }

                        for (let bd_c = bd_c1; bd_c <= bd_c2; bd_c += 1) {
                            if (bd_r === bd_r1) {
                                if (!isNil(data[bd_r]?.[bd_c]?.mc)) {
                                } else {
                                    if (borderInfoCompute[`${bd_r}_${bd_c}`] === undefined) {
                                        borderInfoCompute[`${bd_r}_${bd_c}`] = {};
                                    }

                                    borderInfoCompute[`${bd_r}_${bd_c}`].b = {
                                        color: borderColor,
                                        style: borderStyle,
                                    };
                                }
                            } else if (bd_r === bd_r2) {
                                if (!isNil(data[bd_r]?.[bd_c]?.mc)) {
                                } else {
                                    if (borderInfoCompute[`${bd_r}_${bd_c}`] === undefined) {
                                        borderInfoCompute[`${bd_r}_${bd_c}`] = {};
                                    }

                                    borderInfoCompute[`${bd_r}_${bd_c}`].t = {
                                        color: borderColor,
                                        style: borderStyle,
                                    };
                                }
                            } else {
                                if (!isNil(data[bd_r]?.[bd_c]?.mc)) {
                                    const cell = data[bd_r][bd_c];

                                    const mc = cfg.merge?.[`${cell?.mc?.r}_${cell?.mc?.c}`];

                                    if (mc?.r === bd_r) {
                                        if (borderInfoCompute[`${bd_r}_${bd_c}`] === undefined) {
                                            borderInfoCompute[`${bd_r}_${bd_c}`] = {};
                                        }

                                        borderInfoCompute[`${bd_r}_${bd_c}`].t = {
                                            color: borderColor,
                                            style: borderStyle,
                                        };
                                    } else if (mc && mc.r + mc.rs - 1 === bd_r) {
                                        if (borderInfoCompute[`${bd_r}_${bd_c}`] === undefined) {
                                            borderInfoCompute[`${bd_r}_${bd_c}`] = {};
                                        }

                                        borderInfoCompute[`${bd_r}_${bd_c}`].b = {
                                            color: borderColor,
                                            style: borderStyle,
                                        };
                                    }
                                } else {
                                    if (borderInfoCompute[`${bd_r}_${bd_c}`] === undefined) {
                                        borderInfoCompute[`${bd_r}_${bd_c}`] = {};
                                    }

                                    borderInfoCompute[`${bd_r}_${bd_c}`].t = {
                                        color: borderColor,
                                        style: borderStyle,
                                    };
                                    borderInfoCompute[`${bd_r}_${bd_c}`].b = {
                                        color: borderColor,
                                        style: borderStyle,
                                    };
                                }
                            }
                        }
                    }
                } else if (borderType === 'border-vertical') {
                    for (let bd_r = bd_r1; bd_r <= bd_r2; bd_r += 1) {
                        if (!isNil(cfg.rowhidden) && !isNil(cfg.rowhidden[bd_r])) {
                            continue;
                        }

                        for (let bd_c = bd_c1; bd_c <= bd_c2; bd_c += 1) {
                            if (bd_c === bd_c1) {
                                if (!isNil(data[bd_r]?.[bd_c]?.mc)) {
                                } else {
                                    if (borderInfoCompute[`${bd_r}_${bd_c}`] === undefined) {
                                        borderInfoCompute[`${bd_r}_${bd_c}`] = {};
                                    }

                                    borderInfoCompute[`${bd_r}_${bd_c}`].r = {
                                        color: borderColor,
                                        style: borderStyle,
                                    };
                                }
                            } else if (bd_c === bd_c2) {
                                if (!isNil(data[bd_r]?.[bd_c]?.mc)) {
                                } else {
                                    if (borderInfoCompute[`${bd_r}_${bd_c}`] === undefined) {
                                        borderInfoCompute[`${bd_r}_${bd_c}`] = {};
                                    }

                                    borderInfoCompute[`${bd_r}_${bd_c}`].l = {
                                        color: borderColor,
                                        style: borderStyle,
                                    };
                                }
                            } else {
                                if (!isNil(data[bd_r]?.[bd_c]?.mc)) {
                                    const cell = data[bd_r][bd_c];

                                    const mc = cfg.merge?.[`${cell?.mc?.r}_${cell?.mc?.c}`];

                                    if (mc?.c === bd_c) {
                                        if (borderInfoCompute[`${bd_r}_${bd_c}`] === undefined) {
                                            borderInfoCompute[`${bd_r}_${bd_c}`] = {};
                                        }

                                        borderInfoCompute[`${bd_r}_${bd_c}`].l = {
                                            color: borderColor,
                                            style: borderStyle,
                                        };
                                    } else if (mc && mc.c + mc.cs - 1 === bd_c) {
                                        if (borderInfoCompute[`${bd_r}_${bd_c}`] === undefined) {
                                            borderInfoCompute[`${bd_r}_${bd_c}`] = {};
                                        }

                                        borderInfoCompute[`${bd_r}_${bd_c}`].r = {
                                            color: borderColor,
                                            style: borderStyle,
                                        };
                                    }
                                } else {
                                    if (borderInfoCompute[`${bd_r}_${bd_c}`] === undefined) {
                                        borderInfoCompute[`${bd_r}_${bd_c}`] = {};
                                    }

                                    borderInfoCompute[`${bd_r}_${bd_c}`].l = {
                                        color: borderColor,
                                        style: borderStyle,
                                    };
                                    borderInfoCompute[`${bd_r}_${bd_c}`].r = {
                                        color: borderColor,
                                        style: borderStyle,
                                    };
                                }
                            }
                        }
                    }
                } else if (borderType === 'border-none') {
                    for (let bd_r = bd_r1; bd_r <= bd_r2; bd_r += 1) {
                        if (!isNil(cfg.rowhidden) && !isNil(cfg.rowhidden[bd_r])) {
                            continue;
                        }

                        for (let bd_c = bd_c1; bd_c <= bd_c2; bd_c += 1) {
                            if (!isNil(borderInfoCompute[`${bd_r}_${bd_c}`])) {
                                delete borderInfoCompute[`${bd_r}_${bd_c}`];
                            }

                            if (bd_r === bd_r1) {
                                const bd_r_top = bd_r1 - 1;

                                if (bd_r_top >= 0 && borderInfoCompute[`${bd_r_top}_${bd_c}`]) {
                                    delete borderInfoCompute[`${bd_r_top}_${bd_c}`].b;
                                }
                            }

                            if (bd_r === bd_r2) {
                                const bd_r_bottom = bd_r2 + 1;

                                if (bd_r_bottom < data.length && borderInfoCompute[`${bd_r_bottom}_${bd_c}`]) {
                                    delete borderInfoCompute[`${bd_r_bottom}_${bd_c}`].t;
                                }
                            }

                            if (bd_c === bd_c1) {
                                const bd_c_left = bd_c1 - 1;

                                if (bd_c_left >= 0 && borderInfoCompute[`${bd_r}_${bd_c_left}`]) {
                                    delete borderInfoCompute[`${bd_r}_${bd_c_left}`].r;
                                }
                            }

                            if (bd_c === bd_c2) {
                                const bd_c_right = bd_c2 + 1;

                                if (bd_c_right < data[0].length && borderInfoCompute[`${bd_r}_${bd_c_right}`]) {
                                    delete borderInfoCompute[`${bd_r}_${bd_c_right}`].l;
                                }
                            }
                        }
                    }
                }
            }
        } else if (entry.rangeType === 'cell') {
            const { value } = entry;

            const bd_r = value.row_index;
            const bd_c = value.col_index;

            if (bd_r < dataset_row_st || bd_r > dataset_row_ed || bd_c < dataset_col_st || bd_c > dataset_col_ed) {
                continue;
            }

            if (!isNil(cfg.rowhidden) && !isNil(cfg.rowhidden[bd_r])) {
                continue;
            }

            if (!isNil(value.l) || !isNil(value.r) || !isNil(value.t) || !isNil(value.b)) {
                if (borderInfoCompute[`${bd_r}_${bd_c}`] === undefined) {
                    borderInfoCompute[`${bd_r}_${bd_c}`] = {};
                }

                if (!isNil(data[bd_r]?.[bd_c]?.mc)) {
                    const cell: Cell | null = data[bd_r][bd_c];
                    const mc: MergeCell | undefined = cfg.merge?.[`${cell?.mc?.r}_${cell?.mc?.c}`];

                    if (!isNil(value.l) && bd_c === mc?.c) {
                        // Left border
                        borderInfoCompute[`${bd_r}_${bd_c}`].l = {
                            color: value.l.color,
                            style: value.l.style,
                        };

                        const bd_c_left = bd_c - 1;

                        if (bd_c_left >= 0 && borderInfoCompute[`${bd_r}_${bd_c_left}`]) {
                            if (!isNil(data[bd_r]?.[bd_c_left]?.mc)) {
                                const cell_left = data[bd_r][bd_c_left];

                                const mc_l = cfg.merge?.[`${cell_left?.mc?.r}_${cell_left?.mc?.c}`];

                                if (mc_l && mc_l.c + mc_l.cs - 1 === bd_c_left) {
                                    borderInfoCompute[`${bd_r}_${bd_c_left}`].r = {
                                        color: value.l.color,
                                        style: value.l.style,
                                    };
                                }
                            } else {
                                borderInfoCompute[`${bd_r}_${bd_c_left}`].r = {
                                    color: value.l.color,
                                    style: value.l.style,
                                };
                            }
                        }
                    } else {
                        borderInfoCompute[`${bd_r}_${bd_c}`].l = null;
                    }

                    if (!isNil(value.r) && mc && bd_c === mc.c + mc.cs - 1) {
                        // Right border
                        borderInfoCompute[`${bd_r}_${bd_c}`].r = {
                            color: value.r.color,
                            style: value.r.style,
                        };

                        const bd_c_right = bd_c + 1;

                        if (bd_c_right < data[0].length && borderInfoCompute[`${bd_r}_${bd_c_right}`]) {
                            if (!isNil(data[bd_r]?.[bd_c_right]?.mc)) {
                                const cell_right = data[bd_r][bd_c_right];

                                const mc_r = cfg.merge?.[`${cell_right?.mc?.r}_${cell_right?.mc?.c}`];

                                if (mc_r?.c === bd_c_right) {
                                    borderInfoCompute[`${bd_r}_${bd_c_right}`].l = {
                                        color: value.r.color,
                                        style: value.r.style,
                                    };
                                }
                            } else {
                                borderInfoCompute[`${bd_r}_${bd_c_right}`].l = {
                                    color: value.r.color,
                                    style: value.r.style,
                                };
                            }
                        }
                    } else {
                        borderInfoCompute[`${bd_r}_${bd_c}`].r = null;
                    }

                    if (!isNil(value.t) && bd_r === mc?.r) {
                        // Top border
                        borderInfoCompute[`${bd_r}_${bd_c}`].t = {
                            color: value.t.color,
                            style: value.t.style,
                        };

                        const bd_r_top = bd_r - 1;

                        if (bd_r_top >= 0 && borderInfoCompute[`${bd_r_top}_${bd_c}`]) {
                            if (!isNil(data[bd_r_top]?.[bd_c]?.mc)) {
                                const cell_top = data[bd_r_top][bd_c];

                                const mc_t = cfg.merge?.[`${cell_top?.mc?.r}_${cell_top?.mc?.c}`];

                                if (mc_t && mc_t.r + mc_t.rs - 1 === bd_r_top) {
                                    borderInfoCompute[`${bd_r_top}_${bd_c}`].b = {
                                        color: value.t.color,
                                        style: value.t.style,
                                    };
                                }
                            } else {
                                borderInfoCompute[`${bd_r_top}_${bd_c}`].b = {
                                    color: value.t.color,
                                    style: value.t.style,
                                };
                            }
                        }
                    } else {
                        borderInfoCompute[`${bd_r}_${bd_c}`].t = null;
                    }

                    if (!isNil(value.b) && mc && bd_r === mc.r + mc.rs - 1) {
                        // Bottom border
                        borderInfoCompute[`${bd_r}_${bd_c}`].b = {
                            color: value.b.color,
                            style: value.b.style,
                        };

                        const bd_r_bottom = bd_r + 1;

                        if (bd_r_bottom < data.length && borderInfoCompute[`${bd_r_bottom}_${bd_c}`]) {
                            if (!isNil(data[bd_r_bottom]?.[bd_c]?.mc)) {
                                const cell_bottom = data[bd_r_bottom][bd_c];

                                const mc_b = cfg.merge?.[`${cell_bottom?.mc?.r}_${cell_bottom?.mc?.c}`];

                                if (mc_b?.r === bd_r_bottom) {
                                    borderInfoCompute[`${bd_r_bottom}_${bd_c}`].t = {
                                        color: value.b.color,
                                        style: value.b.style,
                                    };
                                }
                            } else {
                                borderInfoCompute[`${bd_r_bottom}_${bd_c}`].t = {
                                    color: value.b.color,
                                    style: value.b.style,
                                };
                            }
                        }
                    } else {
                        borderInfoCompute[`${bd_r}_${bd_c}`].b = null;
                    }
                } else {
                    if (!isNil(value.l)) {
                        // Left border
                        borderInfoCompute[`${bd_r}_${bd_c}`].l = {
                            color: value.l.color,
                            style: value.l.style,
                        };

                        const bd_c_left = bd_c - 1;

                        if (bd_c_left >= 0 && borderInfoCompute[`${bd_r}_${bd_c_left}`]) {
                            if (!isNil(data[bd_r]?.[bd_c_left]?.mc)) {
                                const cell_left = data[bd_r][bd_c_left];

                                const mc_l = cfg.merge?.[`${cell_left?.mc?.r}_${cell_left?.mc?.c}`];

                                if (mc_l && mc_l.c + mc_l.cs - 1 === bd_c_left) {
                                    borderInfoCompute[`${bd_r}_${bd_c_left}`].r = {
                                        color: value.l.color,
                                        style: value.l.style,
                                    };
                                }
                            } else {
                                borderInfoCompute[`${bd_r}_${bd_c_left}`].r = {
                                    color: value.l.color,
                                    style: value.l.style,
                                };
                            }
                        }
                    } else {
                        borderInfoCompute[`${bd_r}_${bd_c}`].l = null;
                    }

                    if (!isNil(value.r)) {
                        // Right border
                        borderInfoCompute[`${bd_r}_${bd_c}`].r = {
                            color: value.r.color,
                            style: value.r.style,
                        };

                        const bd_c_right = bd_c + 1;

                        if (bd_c_right < data[0].length && borderInfoCompute[`${bd_r}_${bd_c_right}`]) {
                            if (
                                !isNil(data[bd_r]) &&
                                isPlainObject(data[bd_r][bd_c_right]) &&
                                !isNil(data[bd_r]?.[bd_c_right]?.mc)
                            ) {
                                const cell_right = data[bd_r][bd_c_right];

                                const mc_r = cfg.merge?.[`${cell_right?.mc?.r}_${cell_right?.mc?.c}`];

                                if (mc_r?.c === bd_c_right) {
                                    borderInfoCompute[`${bd_r}_${bd_c_right}`].l = {
                                        color: value.r.color,
                                        style: value.r.style,
                                    };
                                }
                            } else {
                                borderInfoCompute[`${bd_r}_${bd_c_right}`].l = {
                                    color: value.r.color,
                                    style: value.r.style,
                                };
                            }
                        }
                    } else {
                        borderInfoCompute[`${bd_r}_${bd_c}`].r = null;
                    }

                    if (!isNil(value.t)) {
                        // Top border
                        borderInfoCompute[`${bd_r}_${bd_c}`].t = {
                            color: value.t.color,
                            style: value.t.style,
                        };

                        const bd_r_top = bd_r - 1;

                        if (bd_r_top >= 0 && borderInfoCompute[`${bd_r_top}_${bd_c}`]) {
                            if (!isNil(data[bd_r_top]?.[bd_c]?.mc)) {
                                const cell_top = data[bd_r_top][bd_c];

                                const mc_t = cfg.merge?.[`${cell_top?.mc?.r}_${cell_top?.mc?.c}`];

                                if (mc_t && mc_t.r + mc_t.rs - 1 === bd_r_top) {
                                    borderInfoCompute[`${bd_r_top}_${bd_c}`].b = {
                                        color: value.t.color,
                                        style: value.t.style,
                                    };
                                }
                            } else {
                                borderInfoCompute[`${bd_r_top}_${bd_c}`].b = {
                                    color: value.t.color,
                                    style: value.t.style,
                                };
                            }
                        }
                    } else {
                        borderInfoCompute[`${bd_r}_${bd_c}`].t = null;
                    }

                    if (!isNil(value.b)) {
                        // Bottom border
                        borderInfoCompute[`${bd_r}_${bd_c}`].b = {
                            color: value.b.color,
                            style: value.b.style,
                        };

                        const bd_r_bottom = bd_r + 1;

                        if (bd_r_bottom < data.length && borderInfoCompute[`${bd_r_bottom}_${bd_c}`]) {
                            if (!isNil(data[bd_r_bottom]?.[bd_c]?.mc)) {
                                const cell_bottom = data[bd_r_bottom][bd_c];

                                const mc_b = cfg.merge?.[`${cell_bottom?.mc?.r}_${cell_bottom?.mc?.c}`];

                                if (mc_b?.r === bd_r_bottom) {
                                    borderInfoCompute[`${bd_r_bottom}_${bd_c}`].t = {
                                        color: value.b.color,
                                        style: value.b.style,
                                    };
                                }
                            } else {
                                borderInfoCompute[`${bd_r_bottom}_${bd_c}`].t = {
                                    color: value.b.color,
                                    style: value.b.style,
                                };
                            }
                        }
                    } else {
                        borderInfoCompute[`${bd_r}_${bd_c}`].b = null;
                    }
                }
            } else {
                delete borderInfoCompute[`${bd_r}_${bd_c}`];
            }
        }
    }

    return borderInfoCompute;
}

// Same loose return as `getBorderInfoComputeRange` — see comment there.
// biome-ignore lint/suspicious/noExplicitAny: see comment on getBorderInfoComputeRange
export function getBorderInfoCompute(ctx: Context, sheetId?: string): Record<string, any> {
    const flowdata = getFlowdata(ctx);

    let data: CellMatrix | null | undefined;
    if (sheetId === undefined) {
        data = flowdata;
    } else {
        const index = getSheetIndex(ctx, sheetId);
        if (isNil(index)) return {};
        data = ctx.luckysheetfile[index].data;
    }

    if (!data) return {};

    return getBorderInfoComputeRange(ctx, 0, data.length, 0, data[0].length, sheetId);
}
