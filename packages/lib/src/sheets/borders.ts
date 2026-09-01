import type { BorderStyleName, CellBorderSides, MergeCell } from './types';

export const BORDER_SIDE_CSS = [
    ['l', 'left'],
    ['r', 'right'],
    ['t', 'top'],
    ['b', 'bottom'],
] as const;

// The one home for the border-style ordinal (1-13, the number stored in `BorderSide.style`):
// its xlsx style name and its CSS shorthand. Every emitter derives from this — the HTML/PDF
// export, the xlsx round-trip, the canvas dash pass, the copy-as-HTML serializer — so FE and BE
// never disagree about what an ordinal means.
export const BORDER_STYLES: Record<number, { name: BorderStyleName; css: string }> = {
    1: { name: 'thin', css: '1px solid' },
    2: { name: 'hair', css: '1px dotted' },
    3: { name: 'dotted', css: '1px dotted' },
    4: { name: 'dashed', css: '1px dashed' },
    5: { name: 'dashDot', css: '1px dashed' },
    6: { name: 'dashDotDot', css: '1px dashed' },
    7: { name: 'double', css: '3px double' },
    8: { name: 'medium', css: '2px solid' },
    9: { name: 'mediumDashed', css: '2px dashed' },
    10: { name: 'mediumDashDot', css: '2px dashed' },
    11: { name: 'mediumDashDotDot', css: '2px dashed' },
    12: { name: 'slantDashDot', css: '2px dashed' },
    13: { name: 'thick', css: '3px solid' },
};

// The CSS shorthand for one border side — `<width> <style> <color>`, no trailing `;` — shared
// by the HTML/PDF export and the copy-as-HTML serializer so a copied cell pastes with the same
// border it exports. The BE escapes `color` at its export seam before calling; the FE passes the
// raw color. Each caller owns its own `;` handling.
export function borderSideCss(style: number, color: string): string {
    return `${BORDER_STYLES[style]?.css ?? '1px solid'} ${color}`;
}

// Visits the map's entries inside a rectangle. Select-all on a tall sheet is a million-cell
// rectangle over a near-empty map; a one-cell paste into a huge map is the reverse — and the
// canvas asks every scroll frame — so walk whichever of the two is smaller.
export function forEachInRect(
    map: Record<string, CellBorderSides>,
    rowSt: number,
    rowEd: number,
    colSt: number,
    colEd: number,
    visit: (key: string, r: number, c: number) => void,
) {
    const area = (rowEd - rowSt + 1) * (colEd - colSt + 1);
    let size = 0;
    for (const _ in map) if ((size += 1) >= area) break;
    if (size < area) {
        for (const key in map) {
            const [r, c] = parseCellKey(key);
            if (r >= rowSt && r <= rowEd && c >= colSt && c <= colEd) visit(key, r, c);
        }
        return;
    }
    for (let r = rowSt; r <= rowEd; r += 1) {
        for (let c = colSt; c <= colEd; c += 1) {
            const key = `${r}_${c}`;
            if (map[key]) visit(key, r, c);
        }
    }
}

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

// The "r_c" key every cell-keyed map shares (merge, borderInfo, dataVerification, hyperlink).
export function parseCellKey(key: string): [row: number, col: number] {
    const sep = key.indexOf('_');
    return [Number(key.substring(0, sep)), Number(key.substring(sep + 1))];
}

// Folds each merge's perimeter onto its master for readers that address a merge through one
// cell (an exceljs style, an HTML td). Storage keeps every constituent's sides for an unmerge.
// `range` is required so the work is bounded: only its cells and the merges crossing it are
// visited (a rangeless call expanded EVERY merge — one legal A1:A100000 merge = ~100k entries).
export function mergedBorderSides(
    borderInfo: Record<string, CellBorderSides> | undefined,
    merge: Record<string, MergeCell> | undefined,
    range: [rowSt: number, rowEd: number, colSt: number, colEd: number],
): Record<string, CellBorderSides> {
    const folded: Record<string, CellBorderSides> = {};
    if (!borderInfo) return folded;
    const [rowSt, rowEd, colSt, colEd] = range;
    const mergeAt = new Map<string, MergeCell>();
    for (const key in merge) {
        const m = merge[key];
        if (m.r > rowEd || m.r + m.rs - 1 < rowSt || m.c > colEd || m.c + m.cs - 1 < colSt) continue;
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

    // Non-merged cells in the rect fold straight through; merge constituents are handled
    // separately below so their sides collapse onto the master exactly once.
    forEachInRect(borderInfo, rowSt, rowEd, colSt, colEd, (key, r, c) => {
        if (!mergeAt.has(key)) fold(key, r, c);
    });
    // Every constituent of a crossing merge, inside the rect or not, folds once here.
    for (const key of mergeAt.keys()) fold(key, ...parseCellKey(key));
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
