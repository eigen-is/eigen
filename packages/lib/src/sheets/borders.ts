// Folds a merge's stored borders onto its master. Storage keeps every constituent's own
// sides (an unmerge shows them again); exporters that address a merge through one cell
// (exceljs shares one style across a merge, an HTML td spans it) need the perimeter on
// the master: a side counts only from the constituent on the merge's matching edge, the
// diagonal only from the master. Same-side conflicts resolve last-write-wins in map order.

import type { CellBorderSides, MergeCell } from './types';

export function mergedBorderSides(
    borderInfo: Record<string, CellBorderSides> | undefined,
    merge: Record<string, MergeCell> | undefined,
): Record<string, CellBorderSides> {
    if (!borderInfo) return {};
    const mergeAt = new Map<string, MergeCell>();
    for (const m of Object.values(merge ?? {})) {
        for (let r = m.r; r < m.r + m.rs; r += 1) {
            for (let c = m.c; c < m.c + m.cs; c += 1) mergeAt.set(`${r}_${c}`, m);
        }
    }

    const folded: Record<string, CellBorderSides> = {};
    for (const [key, sides] of Object.entries(borderInfo)) {
        const m = mergeAt.get(key);
        if (!m) {
            folded[key] = sides;
            continue;
        }
        const [r, c] = key.split('_').map(Number);
        const master = (folded[`${m.r}_${m.c}`] ??= {});
        if (sides.l && c === m.c) master.l = sides.l;
        if (sides.r && c === m.c + m.cs - 1) master.r = sides.r;
        if (sides.t && r === m.r) master.t = sides.t;
        if (sides.b && r === m.r + m.rs - 1) master.b = sides.b;
        if (sides.s && r === m.r && c === m.c) master.s = sides.s;
        if (Object.keys(master).length === 0) delete folded[`${m.r}_${m.c}`];
    }
    return folded;
}
