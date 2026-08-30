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
        const edge = mergeEdgeSides(sides, m, r, c);
        if (edge) Object.assign((folded[`${m.r}_${m.c}`] ??= {}), edge);
    }
    return folded;
}

// The sides of a merged constituent that lie on the merge's outer edge — what a painter or
// exporter shows for it; the diagonal belongs to the master alone. Undefined when none do.
export function mergeEdgeSides(
    sides: CellBorderSides,
    mc: MergeCell,
    r: number,
    c: number,
): CellBorderSides | undefined {
    const edge: CellBorderSides = {};
    if (sides.l && c === mc.c) edge.l = sides.l;
    if (sides.r && c === mc.c + mc.cs - 1) edge.r = sides.r;
    if (sides.t && r === mc.r) edge.t = sides.t;
    if (sides.b && r === mc.r + mc.rs - 1) edge.b = sides.b;
    if (sides.s && r === mc.r && c === mc.c) edge.s = sides.s;
    return Object.keys(edge).length > 0 ? edge : undefined;
}
