import type { BorderStyleName, CellBorderSides, MergeCell } from './types';

export const BORDER_SIDE_CSS = [
    ['l', 'left'],
    ['r', 'right'],
    ['t', 'top'],
    ['b', 'bottom'],
] as const;

// The one home for the border-style ordinal (1-13, the number stored in `BorderSide.style`):
// its xlsx style name, its CSS shorthand, and the canvas paint (`dash` = setLineDash pattern in
// px, `[0]` = solid; `lineWidth` = stroke width in px). Every emitter derives from this — the
// HTML/PDF export, the xlsx round-trip, the canvas dash pass, the copy-as-HTML serializer — so
// FE and BE never disagree about what an ordinal means. The canvas nudges any `lineWidth === 2`
// (the "medium" family) half a pixel across its own axis for a crisp line.
//
// `dash`/`lineWidth` encode exactly what the old canvas cascade produced. Two ordinals diverge
// between screen and print, pre-existing and deliberate: double (7) and slantDashDot (12) paint at
// `lineWidth` 1 on canvas while their `css` says 3px/2px. Left as-is.
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

// The CSS shorthand for one border side — `<width> <style> <color>`, no trailing `;` — shared
// by the HTML/PDF export and the copy-as-HTML serializer so a copied cell pastes with the same
// border it exports. The BE escapes `color` at its export seam before calling; the FE passes the
// raw color. Each caller owns its own `;` handling.
export function borderSideCss(style: number, color: string): string {
    return `${BORDER_STYLES[style]?.css ?? '1px solid'} ${color}`;
}

// The `border-<side>:<shorthand>` declarations for a cell's sides, shared by the HTML/PDF export
// (BE, `escapeHtml` for `mapColor`, joins with `;`) and the copy-as-HTML serializer (FE, raw
// color). `s` (the diagonal) has no CSS equivalent, so it is never emitted — BORDER_SIDE_CSS
// covers only l/r/t/b. Returns bare declarations with no trailing `;`; each caller owns its join.
export function borderSidesToCss(sides: CellBorderSides, mapColor: (color: string) => string = (c) => c): string[] {
    const decls: string[] = [];
    for (const [key, name] of BORDER_SIDE_CSS) {
        const side = sides[key];
        if (side) decls.push(`border-${name}:${borderSideCss(side.style, mapColor(side.color))}`);
    }
    return decls;
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

// The row/col bounding box of a `borderInfo` map's raw keys — the bordered extent, shared by the
// xlsx writer (which reads max only) and the HTML export's grid-bounds. Empty map → an inverted
// box (`maxRow`/`maxCol` -1), which merges into a running extent as a no-op.
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
        if (r < minRow) minRow = r;
        if (c < minCol) minCol = c;
        if (r > maxRow) maxRow = r;
        if (c > maxCol) maxCol = c;
    }
    return { minRow, minCol, maxRow, maxCol };
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
    // Nothing to fold onto a master from an empty map — bail before walking the merges' full extent.
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
