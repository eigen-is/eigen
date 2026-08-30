import {
    type BorderSide,
    type BorderType,
    type CellBorderSides,
    cloneSides,
    type MergeCell,
    mergeEdgeSides,
    parseCellKey,
} from '@workspace/lib/sheets';
import type { Context } from '../context';
import type { Selection, SheetConfig } from '../types';
import { getSheetIndex } from '../utils';

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

type BorderSideKey = keyof CellBorderSides;

// Visits the map's entries inside a rectangle. Select-all on a tall sheet is a million-cell
// rectangle over a near-empty map; a one-cell paste into a huge map is the reverse — and the
// canvas asks every scroll frame — so walk whichever of the two is smaller.
function forEachInRect(
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

// A cell's sides as every reader sees them: a merged constituent shows only the sides on the
// merge's outer edge (storage stays raw so an unmerge shows them again), the diagonal is the
// master's. Hidden rows and columns are kept — a carry must still move their borders; the
// painter skips them itself.
export function getBorderInfoCompute(
    ctx: Context,
    sheetId: string,
    range: [rowSt: number, rowEd: number, colSt: number, colEd: number],
): Record<string, CellBorderSides> {
    const computed: Record<string, CellBorderSides> = {};
    const index = getSheetIndex(ctx, sheetId);
    if (index == null) return computed;
    const { config: cfg, data } = ctx.sheets[index];
    const map = cfg?.borderInfo;
    if (!map || !data) return computed;

    forEachInRect(map, ...range, (key, r, c) => {
        const anchor = data[r]?.[c]?.mc;
        const mc: MergeCell | undefined = anchor && cfg.merge?.[`${anchor.r}_${anchor.c}`];
        const sides = mc ? mergeEdgeSides(map[key], mc, r, c) : map[key];
        if (sides) computed[key] = sides;
    });
    return computed;
}

function removeSide(map: Record<string, CellBorderSides>, r: number, c: number, key: BorderSideKey) {
    const entry = map[`${r}_${c}`];
    if (!entry) return;
    delete entry[key];
    if (Object.keys(entry).length === 0) delete map[`${r}_${c}`];
}

// Carries a source cell's computed sides onto a destination cell (paste, fill, move,
// format painter): a source without sides clears the destination, so a plain cell
// pasted over a bordered one leaves it plain.
export function carrySides(map: Record<string, CellBorderSides>, r: number, c: number, sides?: CellBorderSides) {
    if (sides) map[`${r}_${c}`] = cloneSides(sides);
    else delete map[`${r}_${c}`];
}

export function clearSides(
    map: Record<string, CellBorderSides> | undefined,
    rowSt: number,
    rowEd: number,
    colSt: number,
    colEd: number,
) {
    if (map) forEachInRect(map, rowSt, rowEd, colSt, colEd, (key) => delete map[key]);
}

// Expands a toolbar layout into the cells' own sides. A border belongs to the cell it was
// drawn on — nothing is mirrored onto the neighbour across the shared edge, which would
// create the neighbour's key as one whole-object add and clobber a peer's write to it.
export function applyBorder(cfg: SheetConfig, type: BorderType, side: BorderSide, ranges: Selection[]) {
    const map = (cfg.borderInfo ??= {});
    for (const { row, column } of ranges) {
        const [r1, r2] = row;
        const [c1, c2] = column;
        if (type === 'border-none') {
            // The outside neighbours lose their facing side too, so the shared edges go fully blank.
            clearSides(map, r1, r2, c1, c2);
            for (let c = c1; c <= c2; c += 1) {
                removeSide(map, r1 - 1, c, 'b');
                removeSide(map, r2 + 1, c, 't');
            }
            for (let r = r1; r <= r2; r += 1) {
                removeSide(map, r, c1 - 1, 'r');
                removeSide(map, r, c2 + 1, 'l');
            }
            continue;
        }
        for (let r = r1; r <= r2; r += 1) {
            for (let c = c1; c <= c2; c += 1) {
                // The key is created by the cell's first side only, so the sync patch stays
                // granular and a cell that takes no side gets no entry; each side is a fresh object.
                let entry: CellBorderSides | undefined;
                const set = (key: BorderSideKey) => {
                    (entry ??= map[`${r}_${c}`] ??= {})[key] = { style: side.style, color: side.color };
                };
                switch (type) {
                    case 'border-all':
                        set('l');
                        set('r');
                        set('t');
                        set('b');
                        break;
                    case 'border-slash':
                        set('s');
                        break;
                    case 'border-outside':
                        if (r === r1) set('t');
                        if (r === r2) set('b');
                        if (c === c1) set('l');
                        if (c === c2) set('r');
                        break;
                    case 'border-inside':
                        // Inner edges expressed once, as the top/left side of the cell below/right.
                        if (r > r1) set('t');
                        if (c > c1) set('l');
                        break;
                    case 'border-horizontal':
                        // First row takes the edge below it, last row the edge above, inner rows
                        // both — so a single-row range still gets a bottom edge.
                        if (r !== r1) set('t');
                        if (r === r1 || r !== r2) set('b');
                        break;
                    case 'border-vertical':
                        if (c !== c1) set('l');
                        if (c === c1 || c !== c2) set('r');
                        break;
                    case 'border-left':
                        if (c === c1) set('l');
                        break;
                    case 'border-right':
                        if (c === c2) set('r');
                        break;
                    case 'border-top':
                        if (r === r1) set('t');
                        break;
                    case 'border-bottom':
                        if (r === r2) set('b');
                        break;
                }
            }
        }
    }
}
