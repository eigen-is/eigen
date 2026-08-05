import type { BorderSide, MergeCell } from '@workspace/lib/sheets';
import { isEmpty, isNil, isPlainObject } from 'es-toolkit/compat';
import type { Cell, CellMatrix } from '../../engine/types';
import { type Context, getFlowdata } from '../context';
import type { SheetConfig } from '../types';
import { getSheetIndex } from '../utils';

// Resolved per-cell border map keyed by `${row}_${col}`. Each side may be:
//   undefined → no border ever set on this side
//   null      → border explicitly cleared (preserved across serialize)
//   BorderSide→ active border
// Producers (paste/dropCell/moveCells/selection) write entries back into
// `CellBorderInfo.value` whose sides are typed the same way, so the shapes
// line up without per-call coercion.
export type ComputedBorderEntry = {
    s?: BorderSide | null;
    l?: BorderSide | null;
    r?: BorderSide | null;
    t?: BorderSide | null;
    b?: BorderSide | null;
};
export type ComputedBorderMap = Record<string, ComputedBorderEntry>;

// The xlsx border-style ordinal → style name; consumed by the canvas border
// pass (dash pattern / line width) and the copy-as-HTML serializer.
export const BORDER_STYLE_NAMES: Record<string, string> = {
    '0': 'none',
    '1': 'Thin',
    '2': 'Hair',
    '3': 'Dotted',
    '4': 'Dashed',
    '5': 'DashDot',
    '6': 'DashDotDot',
    '7': 'Double',
    '8': 'Medium',
    '9': 'MediumDashed',
    '10': 'MediumDashDot',
    '11': 'MediumDashDotDot',
    '12': 'SlantedDashDot',
    '13': 'Thick',
};

type BorderSideKey = keyof ComputedBorderEntry;
type PropagableSide = 'l' | 'r' | 't' | 'b';

// Ensure `${r}_${c}` has an entry, creating it (empty) only on first touch — same
// `=== undefined` guard the branches used inline, so key insertion order is
// unchanged.
function ensureEntry(map: ComputedBorderMap, r: number, c: number): ComputedBorderEntry {
    const key = `${r}_${c}`;
    let entry = map[key];
    if (entry === undefined) {
        entry = {};
        map[key] = entry;
    }
    return entry;
}

// Stamp one side of (r, c) with a fresh border object (the branches always wrote a
// new `{ color, style }` literal, never a shared reference — preserved here).
function setSide(
    map: ComputedBorderMap,
    r: number,
    c: number,
    side: BorderSideKey,
    color: string,
    style: number,
): void {
    ensureEntry(map, r, c)[side] = { color, style };
}

// Merge-aware neighbour geometry. A border on `side` of the source cell also lands
// on the OPPOSITE side of the adjacent cell across that side. When that neighbour is
// merged, only the merge edge that touches the source may receive it.
const NEIGHBOUR: Record<
    PropagableSide,
    {
        opposite: PropagableSide;
        dr: number;
        dc: number;
        inBounds: (data: CellMatrix, r: number, c: number) => boolean;
        onMergeEdge: (mc: MergeCell, r: number, c: number) => boolean;
    }
> = {
    l: {
        opposite: 'r',
        dr: 0,
        dc: -1,
        inBounds: (_d, _r, c) => c >= 0,
        onMergeEdge: (mc, _r, c) => mc.c + mc.cs - 1 === c,
    },
    r: { opposite: 'l', dr: 0, dc: 1, inBounds: (d, _r, c) => c < d[0].length, onMergeEdge: (mc, _r, c) => mc.c === c },
    t: { opposite: 'b', dr: -1, dc: 0, inBounds: (_d, r) => r >= 0, onMergeEdge: (mc, r) => mc.r + mc.rs - 1 === r },
    b: { opposite: 't', dr: 1, dc: 0, inBounds: (d, r) => r < d.length, onMergeEdge: (mc, r) => mc.r === r },
};

// Propagate a border across `side` to the merge-aware neighbour. Only writes when
// that neighbour entry already exists — every original propagation block guarded on
// the neighbour key being present, so this never creates keys.
function propagateToNeighbour(
    map: ComputedBorderMap,
    data: CellMatrix,
    merge: Record<string, MergeCell> | undefined,
    r: number,
    c: number,
    side: PropagableSide,
    color: string,
    style: number,
): void {
    const dir = NEIGHBOUR[side];
    const nr = r + dir.dr;
    const nc = c + dir.dc;
    if (!dir.inBounds(data, nr, nc)) return;

    const entry = map[`${nr}_${nc}`];
    if (!entry) return;

    const neighbourCell = data[nr]?.[nc];
    if (isPlainObject(neighbourCell) && !isNil(neighbourCell?.mc)) {
        const mc = merge?.[`${neighbourCell?.mc?.r}_${neighbourCell?.mc?.c}`];
        if (mc && dir.onMergeEdge(mc, nr, nc)) {
            entry[dir.opposite] = { color, style };
        }
    } else {
        entry[dir.opposite] = { color, style };
    }
}

export function getBorderInfoComputeRange(
    ctx: Context,
    dataset_row_st: number,
    dataset_row_ed: number,
    dataset_col_st: number,
    dataset_col_ed: number,
    sheetId?: string,
): ComputedBorderMap {
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
        cfg = ctx.sheets[index].config;
        data = ctx.sheets[index].data;
    }
    if (!data || !cfg) return borderInfoCompute;

    const borderInfo = cfg.borderInfo ?? [];

    if (isEmpty(borderInfo)) return borderInfoCompute;

    // Hoisted once: recomputing Object.keys(cfg.merge) per bordered row/column
    // made every border pass O(rows x merges).
    const mergeCells = Object.values(cfg.merge || {});

    for (let i = 0; i < borderInfo.length; i += 1) {
        const entry = borderInfo[i];

        if (entry.rangeType === 'range') {
            const { borderType, color: borderColor, range: borderRange } = entry;
            // RangeBorderInfo.style is `number | string` (toolbar pushes '1'..'13'
            // as strings); coerce to number here so ComputedBorderEntry sides
            // match the canonical BorderSide shape end-to-end.
            const borderStyle = typeof entry.style === 'string' ? Number(entry.style) : entry.style;

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
                    const bd_r = borderRange[j].row_focus;
                    const bd_c = borderRange[j].column_focus;
                    if (bd_r == null || bd_c == null) continue;
                    if (cfg.rowhidden?.[bd_r] != null) continue;
                    if (bd_c < dataset_col_st || bd_c > dataset_col_ed) continue;
                    if (bd_r < dataset_row_st || bd_r > dataset_row_ed) continue;
                    setSide(borderInfoCompute, bd_r, bd_c, 's', borderColor, borderStyle);
                }
                if (borderType === 'border-left') {
                    for (let bd_r = bd_r1; bd_r <= bd_r2; bd_r += 1) {
                        if (!isNil(cfg.rowhidden) && !isNil(cfg.rowhidden[bd_r])) {
                            continue;
                        }

                        setSide(borderInfoCompute, bd_r, bd_c1, 'l', borderColor, borderStyle);
                        propagateToNeighbour(
                            borderInfoCompute,
                            data,
                            cfg.merge,
                            bd_r,
                            bd_c1,
                            'l',
                            borderColor,
                            borderStyle,
                        );

                        for (const { c, r, cs, rs } of mergeCells) {
                            if (bd_c1 <= c + cs - 1 && bd_c1 > c && bd_r >= r && bd_r <= r + rs - 1) {
                                borderInfoCompute[`${bd_r}_${bd_c1}`].l = null;
                            }
                        }
                    }
                } else if (borderType === 'border-right') {
                    for (let bd_r = bd_r1; bd_r <= bd_r2; bd_r += 1) {
                        if (!isNil(cfg.rowhidden) && !isNil(cfg.rowhidden[bd_r])) {
                            continue;
                        }

                        setSide(borderInfoCompute, bd_r, bd_c2, 'r', borderColor, borderStyle);
                        propagateToNeighbour(
                            borderInfoCompute,
                            data,
                            cfg.merge,
                            bd_r,
                            bd_c2,
                            'r',
                            borderColor,
                            borderStyle,
                        );

                        for (const { c, r, cs, rs } of mergeCells) {
                            if (bd_c2 < c + cs - 1 && bd_c2 >= c && bd_r >= r && bd_r <= r + rs - 1) {
                                borderInfoCompute[`${bd_r}_${bd_c2}`].r = null;
                            }
                        }
                    }
                } else if (borderType === 'border-top') {
                    if (!isNil(cfg.rowhidden) && !isNil(cfg.rowhidden[bd_r1])) {
                        continue;
                    }

                    for (let bd_c = bd_c1; bd_c <= bd_c2; bd_c += 1) {
                        setSide(borderInfoCompute, bd_r1, bd_c, 't', borderColor, borderStyle);
                        propagateToNeighbour(
                            borderInfoCompute,
                            data,
                            cfg.merge,
                            bd_r1,
                            bd_c,
                            't',
                            borderColor,
                            borderStyle,
                        );

                        for (const { c, r, cs, rs } of mergeCells) {
                            if (bd_r1 <= r + rs - 1 && bd_r1 > r && bd_c >= c && bd_c <= c + cs - 1) {
                                borderInfoCompute[`${bd_r1}_${bd_c}`].t = null;
                            }
                        }
                    }
                } else if (borderType === 'border-bottom') {
                    if (!isNil(cfg.rowhidden) && !isNil(cfg.rowhidden[bd_r2])) {
                        continue;
                    }

                    for (let bd_c = bd_c1; bd_c <= bd_c2; bd_c += 1) {
                        setSide(borderInfoCompute, bd_r2, bd_c, 'b', borderColor, borderStyle);
                        propagateToNeighbour(
                            borderInfoCompute,
                            data,
                            cfg.merge,
                            bd_r2,
                            bd_c,
                            'b',
                            borderColor,
                            borderStyle,
                        );

                        for (const { c, r, cs, rs } of mergeCells) {
                            if (bd_r2 < r + rs - 1 && bd_r2 >= r && bd_c >= c && bd_c <= c + cs - 1) {
                                borderInfoCompute[`${bd_r2}_${bd_c}`].b = null;
                            }
                        }
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
                                    setSide(borderInfoCompute, bd_r, bd_c, 't', borderColor, borderStyle);
                                }

                                if (mc && mc.r + mc.rs - 1 === bd_r) {
                                    setSide(borderInfoCompute, bd_r, bd_c, 'b', borderColor, borderStyle);
                                }

                                if (mc?.c === bd_c) {
                                    setSide(borderInfoCompute, bd_r, bd_c, 'l', borderColor, borderStyle);
                                }

                                if (mc && mc.c + mc.cs - 1 === bd_c) {
                                    setSide(borderInfoCompute, bd_r, bd_c, 'r', borderColor, borderStyle);
                                }
                            } else {
                                setSide(borderInfoCompute, bd_r, bd_c, 'l', borderColor, borderStyle);
                                setSide(borderInfoCompute, bd_r, bd_c, 'r', borderColor, borderStyle);
                                setSide(borderInfoCompute, bd_r, bd_c, 't', borderColor, borderStyle);
                                setSide(borderInfoCompute, bd_r, bd_c, 'b', borderColor, borderStyle);
                            }

                            if (bd_r === bd_r1) {
                                propagateToNeighbour(
                                    borderInfoCompute,
                                    data,
                                    cfg.merge,
                                    bd_r,
                                    bd_c,
                                    't',
                                    borderColor,
                                    borderStyle,
                                );
                            }

                            if (bd_r === bd_r2) {
                                propagateToNeighbour(
                                    borderInfoCompute,
                                    data,
                                    cfg.merge,
                                    bd_r,
                                    bd_c,
                                    'b',
                                    borderColor,
                                    borderStyle,
                                );
                            }

                            if (bd_c === bd_c1) {
                                propagateToNeighbour(
                                    borderInfoCompute,
                                    data,
                                    cfg.merge,
                                    bd_r,
                                    bd_c,
                                    'l',
                                    borderColor,
                                    borderStyle,
                                );
                            }

                            if (bd_c === bd_c2) {
                                propagateToNeighbour(
                                    borderInfoCompute,
                                    data,
                                    cfg.merge,
                                    bd_r,
                                    bd_c,
                                    'r',
                                    borderColor,
                                    borderStyle,
                                );
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
                                setSide(borderInfoCompute, bd_r, bd_c, 't', borderColor, borderStyle);
                                propagateToNeighbour(
                                    borderInfoCompute,
                                    data,
                                    cfg.merge,
                                    bd_r,
                                    bd_c,
                                    't',
                                    borderColor,
                                    borderStyle,
                                );
                            }

                            if (bd_r === bd_r2) {
                                setSide(borderInfoCompute, bd_r, bd_c, 'b', borderColor, borderStyle);
                                propagateToNeighbour(
                                    borderInfoCompute,
                                    data,
                                    cfg.merge,
                                    bd_r,
                                    bd_c,
                                    'b',
                                    borderColor,
                                    borderStyle,
                                );
                            }

                            if (bd_c === bd_c1) {
                                setSide(borderInfoCompute, bd_r, bd_c, 'l', borderColor, borderStyle);
                                propagateToNeighbour(
                                    borderInfoCompute,
                                    data,
                                    cfg.merge,
                                    bd_r,
                                    bd_c,
                                    'l',
                                    borderColor,
                                    borderStyle,
                                );
                            }

                            if (bd_c === bd_c2) {
                                setSide(borderInfoCompute, bd_r, bd_c, 'r', borderColor, borderStyle);
                                propagateToNeighbour(
                                    borderInfoCompute,
                                    data,
                                    cfg.merge,
                                    bd_r,
                                    bd_c,
                                    'r',
                                    borderColor,
                                    borderStyle,
                                );
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
                                    ensureEntry(borderInfoCompute, bd_r, bd_c);
                                }
                            } else if (bd_r === bd_r2 && bd_c === bd_c1) {
                                if (!isNil(data[bd_r]?.[bd_c]?.mc)) {
                                } else {
                                    setSide(borderInfoCompute, bd_r, bd_c, 't', borderColor, borderStyle);
                                }
                            } else if (bd_r === bd_r1 && bd_c === bd_c2) {
                                if (!isNil(data[bd_r]?.[bd_c]?.mc)) {
                                } else {
                                    setSide(borderInfoCompute, bd_r, bd_c, 'l', borderColor, borderStyle);
                                }
                            } else if (bd_r === bd_r2 && bd_c === bd_c2) {
                                if (!isNil(data[bd_r]?.[bd_c]?.mc)) {
                                } else {
                                    setSide(borderInfoCompute, bd_r, bd_c, 'l', borderColor, borderStyle);
                                    setSide(borderInfoCompute, bd_r, bd_c, 't', borderColor, borderStyle);
                                }
                            } else if (bd_r === bd_r1) {
                                if (!isNil(data[bd_r]?.[bd_c]?.mc)) {
                                    const cell = data[bd_r][bd_c];

                                    const mc = cfg.merge?.[`${cell?.mc?.r}_${cell?.mc?.c}`];

                                    if (mc?.c === bd_c) {
                                        setSide(borderInfoCompute, bd_r, bd_c, 'l', borderColor, borderStyle);
                                    } else if (mc && mc.c + mc.cs - 1 === bd_c) {
                                        ensureEntry(borderInfoCompute, bd_r, bd_c);
                                    }
                                } else {
                                    setSide(borderInfoCompute, bd_r, bd_c, 'l', borderColor, borderStyle);
                                }
                            } else if (bd_r === bd_r2) {
                                if (!isNil(data[bd_r]?.[bd_c]?.mc)) {
                                    const cell = data[bd_r][bd_c];

                                    const mc = cfg.merge?.[`${cell?.mc?.r}_${cell?.mc?.c}`];

                                    if (mc?.c === bd_c) {
                                        setSide(borderInfoCompute, bd_r, bd_c, 'l', borderColor, borderStyle);
                                    } else if (mc && mc.c + mc.cs - 1 === bd_c) {
                                        ensureEntry(borderInfoCompute, bd_r, bd_c);
                                    }
                                } else {
                                    setSide(borderInfoCompute, bd_r, bd_c, 'l', borderColor, borderStyle);
                                    setSide(borderInfoCompute, bd_r, bd_c, 't', borderColor, borderStyle);
                                }
                            } else if (bd_c === bd_c1) {
                                if (!isNil(data[bd_r]?.[bd_c]?.mc)) {
                                    const cell = data[bd_r][bd_c];

                                    const mc = cfg.merge?.[`${cell?.mc?.r}_${cell?.mc?.c}`];

                                    if (mc?.r === bd_r) {
                                        setSide(borderInfoCompute, bd_r, bd_c, 't', borderColor, borderStyle);
                                    } else if (mc && mc.r + mc.rs - 1 === bd_r) {
                                        ensureEntry(borderInfoCompute, bd_r, bd_c);
                                    }
                                } else {
                                    setSide(borderInfoCompute, bd_r, bd_c, 't', borderColor, borderStyle);
                                }
                            } else if (bd_c === bd_c2) {
                                if (!isNil(data[bd_r]?.[bd_c]?.mc)) {
                                    const cell = data[bd_r][bd_c];

                                    const mc = cfg.merge?.[`${cell?.mc?.r}_${cell?.mc?.c}`];

                                    if (mc?.r === bd_r) {
                                        setSide(borderInfoCompute, bd_r, bd_c, 't', borderColor, borderStyle);
                                    } else if (mc && mc.r + mc.rs - 1 === bd_r) {
                                        ensureEntry(borderInfoCompute, bd_r, bd_c);
                                    }
                                } else {
                                    setSide(borderInfoCompute, bd_r, bd_c, 'l', borderColor, borderStyle);
                                    setSide(borderInfoCompute, bd_r, bd_c, 't', borderColor, borderStyle);
                                }
                            } else {
                                if (!isNil(data[bd_r]?.[bd_c]?.mc)) {
                                    const cell = data[bd_r][bd_c];

                                    const mc = cfg.merge?.[`${cell?.mc?.r}_${cell?.mc?.c}`];

                                    if (mc?.r === bd_r) {
                                        setSide(borderInfoCompute, bd_r, bd_c, 't', borderColor, borderStyle);
                                    } else if (mc && mc.r + mc.rs - 1 === bd_r) {
                                        ensureEntry(borderInfoCompute, bd_r, bd_c);
                                    }

                                    if (mc?.c === bd_c) {
                                        setSide(borderInfoCompute, bd_r, bd_c, 'l', borderColor, borderStyle);
                                    } else if (mc && mc.c + mc.cs - 1 === bd_c) {
                                        ensureEntry(borderInfoCompute, bd_r, bd_c);
                                    }
                                } else {
                                    setSide(borderInfoCompute, bd_r, bd_c, 'l', borderColor, borderStyle);
                                    setSide(borderInfoCompute, bd_r, bd_c, 't', borderColor, borderStyle);
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
                                    setSide(borderInfoCompute, bd_r, bd_c, 'b', borderColor, borderStyle);
                                }
                            } else if (bd_r === bd_r2) {
                                if (!isNil(data[bd_r]?.[bd_c]?.mc)) {
                                } else {
                                    setSide(borderInfoCompute, bd_r, bd_c, 't', borderColor, borderStyle);
                                }
                            } else {
                                if (!isNil(data[bd_r]?.[bd_c]?.mc)) {
                                    const cell = data[bd_r][bd_c];

                                    const mc = cfg.merge?.[`${cell?.mc?.r}_${cell?.mc?.c}`];

                                    if (mc?.r === bd_r) {
                                        setSide(borderInfoCompute, bd_r, bd_c, 't', borderColor, borderStyle);
                                    } else if (mc && mc.r + mc.rs - 1 === bd_r) {
                                        setSide(borderInfoCompute, bd_r, bd_c, 'b', borderColor, borderStyle);
                                    }
                                } else {
                                    setSide(borderInfoCompute, bd_r, bd_c, 't', borderColor, borderStyle);
                                    setSide(borderInfoCompute, bd_r, bd_c, 'b', borderColor, borderStyle);
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
                                    setSide(borderInfoCompute, bd_r, bd_c, 'r', borderColor, borderStyle);
                                }
                            } else if (bd_c === bd_c2) {
                                if (!isNil(data[bd_r]?.[bd_c]?.mc)) {
                                } else {
                                    setSide(borderInfoCompute, bd_r, bd_c, 'l', borderColor, borderStyle);
                                }
                            } else {
                                if (!isNil(data[bd_r]?.[bd_c]?.mc)) {
                                    const cell = data[bd_r][bd_c];

                                    const mc = cfg.merge?.[`${cell?.mc?.r}_${cell?.mc?.c}`];

                                    if (mc?.c === bd_c) {
                                        setSide(borderInfoCompute, bd_r, bd_c, 'l', borderColor, borderStyle);
                                    } else if (mc && mc.c + mc.cs - 1 === bd_c) {
                                        setSide(borderInfoCompute, bd_r, bd_c, 'r', borderColor, borderStyle);
                                    }
                                } else {
                                    setSide(borderInfoCompute, bd_r, bd_c, 'l', borderColor, borderStyle);
                                    setSide(borderInfoCompute, bd_r, bd_c, 'r', borderColor, borderStyle);
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
                ensureEntry(borderInfoCompute, bd_r, bd_c);

                if (!isNil(data[bd_r]?.[bd_c]?.mc)) {
                    const cell: Cell | null = data[bd_r][bd_c];
                    const mc: MergeCell | undefined = cfg.merge?.[`${cell?.mc?.r}_${cell?.mc?.c}`];

                    if (!isNil(value.l) && bd_c === mc?.c) {
                        setSide(borderInfoCompute, bd_r, bd_c, 'l', value.l.color, value.l.style);
                        propagateToNeighbour(
                            borderInfoCompute,
                            data,
                            cfg.merge,
                            bd_r,
                            bd_c,
                            'l',
                            value.l.color,
                            value.l.style,
                        );
                    } else {
                        borderInfoCompute[`${bd_r}_${bd_c}`].l = null;
                    }

                    if (!isNil(value.r) && mc && bd_c === mc.c + mc.cs - 1) {
                        setSide(borderInfoCompute, bd_r, bd_c, 'r', value.r.color, value.r.style);
                        propagateToNeighbour(
                            borderInfoCompute,
                            data,
                            cfg.merge,
                            bd_r,
                            bd_c,
                            'r',
                            value.r.color,
                            value.r.style,
                        );
                    } else {
                        borderInfoCompute[`${bd_r}_${bd_c}`].r = null;
                    }

                    if (!isNil(value.t) && bd_r === mc?.r) {
                        setSide(borderInfoCompute, bd_r, bd_c, 't', value.t.color, value.t.style);
                        propagateToNeighbour(
                            borderInfoCompute,
                            data,
                            cfg.merge,
                            bd_r,
                            bd_c,
                            't',
                            value.t.color,
                            value.t.style,
                        );
                    } else {
                        borderInfoCompute[`${bd_r}_${bd_c}`].t = null;
                    }

                    if (!isNil(value.b) && mc && bd_r === mc.r + mc.rs - 1) {
                        setSide(borderInfoCompute, bd_r, bd_c, 'b', value.b.color, value.b.style);
                        propagateToNeighbour(
                            borderInfoCompute,
                            data,
                            cfg.merge,
                            bd_r,
                            bd_c,
                            'b',
                            value.b.color,
                            value.b.style,
                        );
                    } else {
                        borderInfoCompute[`${bd_r}_${bd_c}`].b = null;
                    }
                } else {
                    if (!isNil(value.l)) {
                        setSide(borderInfoCompute, bd_r, bd_c, 'l', value.l.color, value.l.style);
                        propagateToNeighbour(
                            borderInfoCompute,
                            data,
                            cfg.merge,
                            bd_r,
                            bd_c,
                            'l',
                            value.l.color,
                            value.l.style,
                        );
                    } else {
                        borderInfoCompute[`${bd_r}_${bd_c}`].l = null;
                    }

                    if (!isNil(value.r)) {
                        setSide(borderInfoCompute, bd_r, bd_c, 'r', value.r.color, value.r.style);
                        propagateToNeighbour(
                            borderInfoCompute,
                            data,
                            cfg.merge,
                            bd_r,
                            bd_c,
                            'r',
                            value.r.color,
                            value.r.style,
                        );
                    } else {
                        borderInfoCompute[`${bd_r}_${bd_c}`].r = null;
                    }

                    if (!isNil(value.t)) {
                        setSide(borderInfoCompute, bd_r, bd_c, 't', value.t.color, value.t.style);
                        propagateToNeighbour(
                            borderInfoCompute,
                            data,
                            cfg.merge,
                            bd_r,
                            bd_c,
                            't',
                            value.t.color,
                            value.t.style,
                        );
                    } else {
                        borderInfoCompute[`${bd_r}_${bd_c}`].t = null;
                    }

                    if (!isNil(value.b)) {
                        setSide(borderInfoCompute, bd_r, bd_c, 'b', value.b.color, value.b.style);
                        propagateToNeighbour(
                            borderInfoCompute,
                            data,
                            cfg.merge,
                            bd_r,
                            bd_c,
                            'b',
                            value.b.color,
                            value.b.style,
                        );
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

export function getBorderInfoCompute(ctx: Context, sheetId?: string): ComputedBorderMap {
    const flowdata = getFlowdata(ctx);

    let data: CellMatrix | null | undefined;
    if (sheetId === undefined) {
        data = flowdata;
    } else {
        const index = getSheetIndex(ctx, sheetId);
        if (isNil(index)) return {};
        data = ctx.sheets[index].data;
    }

    if (!data) return {};

    return getBorderInfoComputeRange(ctx, 0, data.length, 0, data[0].length, sheetId);
}
