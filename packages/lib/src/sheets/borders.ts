import type { CellBorderSides, MergeCell } from './types';

export const BORDER_SIDE_CSS = [
    ['l', 'left'],
    ['r', 'right'],
    ['t', 'top'],
    ['b', 'bottom'],
] as const;

// Cells sharing a source must not share side-object identity: immer and Yjs track each side.
export function cloneSides({ l, r, t, b, s }: CellBorderSides): CellBorderSides {
    return {
        ...(l && { l: { ...l } }),
        ...(r && { r: { ...r } }),
        ...(t && { t: { ...t } }),
        ...(b && { b: { ...b } }),
        ...(s && { s: { ...s } }),
    };
}

// Folds each merge's perimeter onto its master for readers that address a merge through one
// cell (an exceljs style, an HTML td). Storage keeps every constituent's sides for an unmerge.
// With a `range` only its cells and the merges crossing it are visited instead of the whole map.
export function mergedBorderSides(
    borderInfo: Record<string, CellBorderSides> | undefined,
    merge: Record<string, MergeCell> | undefined,
    range?: [rowSt: number, rowEd: number, colSt: number, colEd: number],
): Record<string, CellBorderSides> {
    const folded: Record<string, CellBorderSides> = {};
    if (!borderInfo) return folded;
    const mergeAt = new Map<string, MergeCell>();
    for (const key in merge) {
        const m = merge[key];
        for (let r = m.r; r < m.r + m.rs; r += 1) {
            for (let c = m.c; c < m.c + m.cs; c += 1) mergeAt.set(`${r}_${c}`, m);
        }
    }

    const fold = (key: string, r: number, c: number) => {
        const sides = borderInfo[key];
        if (!sides) return;
        const m = mergeAt.get(key);
        if (!m) {
            folded[key] = sides;
            return;
        }
        const edge = mergeEdgeSides(sides, m, r, c);
        if (edge) Object.assign((folded[`${m.r}_${m.c}`] ??= {}), edge);
    };

    if (!range) {
        for (const key in borderInfo) {
            const sep = key.indexOf('_');
            fold(key, Number(key.substring(0, sep)), Number(key.substring(sep + 1)));
        }
        return folded;
    }
    const [rowSt, rowEd, colSt, colEd] = range;
    for (let r = rowSt; r <= rowEd; r += 1) {
        for (let c = colSt; c <= colEd; c += 1) fold(`${r}_${c}`, r, c);
    }
    for (const key in merge) {
        const m = merge[key];
        if (m.r > rowEd || m.r + m.rs - 1 < rowSt || m.c > colEd || m.c + m.cs - 1 < colSt) continue;
        for (let r = m.r; r < m.r + m.rs; r += 1) {
            for (let c = m.c; c < m.c + m.cs; c += 1) fold(`${r}_${c}`, r, c);
        }
    }
    return folded;
}

// A constituent's sides on the merge's outer edge; the diagonal belongs to the master alone.
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
