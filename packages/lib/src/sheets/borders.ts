// A sheet's cell borders as every reader and writer sees them: what each stored style number draws, the CSS of a
// cell's sides, and the walks over the `r_c`-keyed border map, such as its extent or a merge's sides folded onto its
// first cell. Readers and writers such as the editor's canvas, the exports and the xlsx reader and writer share it,
// so none of them disagrees about a border.

import type { BorderStyleName, CellBorderSides, MergeCell } from './types';

export const BORDER_SIDE_CSS = [
    ['l', 'left'],
    ['r', 'right'],
    ['t', 'top'],
    ['b', 'bottom'],
] as const;

// What each border style number stored in `BorderSide.style` means, from 1 to 13: its xlsx style name, its CSS
// shorthand and its canvas paint. `dash` is the setLineDash pattern in px, where `[0]` is solid, and `lineWidth` is the
// stroke width in px. The canvas nudges a line 2 px wide, the medium styles, half a pixel across its axis so it draws
// crisp. Double (7) and slantDashDot (12) draw 1 px wide on the canvas on purpose, while their CSS prints them 3 px and
// 2 px.
export const BORDER_STYLES: Record<number, { name: BorderStyleName; css: string; dash: number[]; lineWidth: number }> =
    {
        1: { name: 'thin', css: '1px solid', dash: [0], lineWidth: 1 },
        2: { name: 'hair', css: '1px dotted', dash: [1, 2], lineWidth: 1 },
        3: { name: 'dotted', css: '1px dotted', dash: [2], lineWidth: 1 },
        4: { name: 'dashed', css: '1px dashed', dash: [3], lineWidth: 1 },
        5: { name: 'dashDot', css: '1px dashed', dash: [2, 5, 2], lineWidth: 1 },
        6: { name: 'dashDotDot', css: '1px dashed', dash: [2, 2, 5, 2, 2], lineWidth: 1 },
        7: { name: 'double', css: '3px double', dash: [0], lineWidth: 1 },
        8: { name: 'medium', css: '2px solid', dash: [0], lineWidth: 2 },
        9: { name: 'mediumDashed', css: '2px dashed', dash: [3], lineWidth: 2 },
        10: { name: 'mediumDashDot', css: '2px dashed', dash: [2, 5, 2], lineWidth: 2 },
        11: { name: 'mediumDashDotDot', css: '2px dashed', dash: [2, 2, 5, 2, 2], lineWidth: 2 },
        12: { name: 'slantDashDot', css: '2px dashed', dash: [2, 5, 2], lineWidth: 1 },
        13: { name: 'thick', css: '3px solid', dash: [0], lineWidth: 3 },
    };

// The `border-<side>:<width> <style> <color>` declarations for a cell's sides, without a trailing `;`, so each caller
// joins them its own way. mapColor lets a caller check or convert each color, as an export does. The diagonal has no
// CSS equivalent, so it is never written.
export function borderSidesToCss(sides: CellBorderSides, mapColor: (color: string) => string = (c) => c): string[] {
    const decls: string[] = [];
    for (const [key, name] of BORDER_SIDE_CSS) {
        const side = sides[key];
        if (side) decls.push(`border-${name}:${BORDER_STYLES[side.style]?.css ?? '1px solid'} ${mapColor(side.color)}`);
    }
    return decls;
}

// Visits the map's entries inside a rectangle, walking whichever of the two is smaller. Select-all on a tall sheet is
// a million-cell rectangle over a near-empty map, and a one-cell paste into a huge map is the reverse. The canvas asks
// on every scroll frame.
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

// The "r_c" key every cell-keyed map shares, such as the merges, the borders and the hyperlinks.
export function parseCellKey(key: string): [row: number, col: number] {
    const sep = key.indexOf('_');
    return [Number(key.substring(0, sep)), Number(key.substring(sep + 1))];
}

// The bounding box of the bordered cells, by row and column. An empty map gives an inverted box, with `maxRow` and
// `maxCol` at -1, which changes nothing when it merges into a running extent.
export function borderInfoExtent(borderInfo: Record<string, CellBorderSides>): {
    minRow: number;
    minCol: number;
    maxRow: number;
    maxCol: number;
} {
    let minRow = Number.MAX_SAFE_INTEGER;
    let minCol = Number.MAX_SAFE_INTEGER;
    let maxRow = -1;
    let maxCol = -1;
    for (const key in borderInfo) {
        const [r, c] = parseCellKey(key);
        // A lookup builds the key from the cell's row and column, so a key spelled otherwise, such as `1e3_0`, borders
        // no cell and must not stretch the extent.
        if (!Number.isInteger(r) || !Number.isInteger(c) || r < 0 || c < 0 || key !== `${r}_${c}`) continue;
        if (r < minRow) minRow = r;
        if (c < minCol) minCol = c;
        if (r > maxRow) maxRow = r;
        if (c > maxCol) maxCol = c;
    }
    return { minRow, minCol, maxRow, maxCol };
}

// Folds each merge's outer sides onto its first cell, for readers that address a merge through one cell, such as an
// OOXML style or an HTML td. Storage keeps every cell's own sides, so an unmerge gets them back. The range bounds the
// work: only its cells and the merges crossing it are visited. A crossing merge is expanded only where it meets the
// range, because a legal A1:A100000 merge would otherwise build about 100,000 entries. A cell of the merge outside the
// range folds nothing, as nothing there is drawn or copied.
export function mergedBorderSides(
    borderInfo: Record<string, CellBorderSides> | undefined,
    merge: Record<string, MergeCell> | undefined,
    range: [rowSt: number, rowEd: number, colSt: number, colEd: number],
): Record<string, CellBorderSides> {
    const folded: Record<string, CellBorderSides> = {};
    if (!borderInfo) return folded;
    // An empty map has nothing to fold, so it skips the walk over the merges.
    let empty = true;
    for (const _ in borderInfo) {
        empty = false;
        break;
    }
    if (empty) return folded;
    const [rowSt, rowEd, colSt, colEd] = range;
    const mergeAt = new Map<string, MergeCell>();
    for (const key in merge) {
        const m = merge[key];
        if (m.r > rowEd || m.r + m.rs - 1 < rowSt || m.c > colEd || m.c + m.cs - 1 < colSt) continue;
        // Clamp to the intersection so a window-crossing merge never expands its full extent.
        const r0 = Math.max(m.r, rowSt);
        const r1 = Math.min(m.r + m.rs - 1, rowEd);
        const c0 = Math.max(m.c, colSt);
        const c1 = Math.min(m.c + m.cs - 1, colEd);
        for (let r = r0; r <= r1; r += 1) {
            for (let c = c0; c <= c1; c += 1) mergeAt.set(`${r}_${c}`, m);
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
