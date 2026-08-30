import {
    type BorderSide,
    type BorderType,
    type CellBorderSides,
    type MergeCell,
    mergeEdgeSides,
} from '@workspace/lib/sheets';
import { cloneDeep, isEmpty } from 'es-toolkit/compat';
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

// A cell's sides as every reader sees them: a merged constituent shows only the sides on the
// merge's outer edge (storage stays raw so an unmerge shows them again), the diagonal is the
// master's. The canvas pass hands a `range` and walks it instead of the map (every scroll frame
// over hundreds of thousands of entries); it is also the only reader that drops hidden rows and
// columns — a carry must still move their borders.
export function getBorderInfoCompute(
    ctx: Context,
    sheetId?: string,
    range?: [rowSt: number, rowEd: number, colSt: number, colEd: number],
): Record<string, CellBorderSides> {
    const computed: Record<string, CellBorderSides> = {};
    const index = getSheetIndex(ctx, sheetId ?? ctx.currentSheetId);
    if (index == null) return computed;
    const { config: cfg, data } = ctx.sheets[index];
    const map = cfg?.borderInfo;
    if (!map || !data || isEmpty(map)) return computed;

    const compute = (r: number, c: number) => {
        const stored = map[`${r}_${c}`];
        if (!stored) return;
        const anchor = data[r]?.[c]?.mc;
        const mc: MergeCell | undefined = anchor && cfg.merge?.[`${anchor.r}_${anchor.c}`];
        const sides = mc ? mergeEdgeSides(stored, mc, r, c) : stored;
        if (sides) computed[`${r}_${c}`] = sides;
    };
    if (!range) {
        for (const key of Object.keys(map)) {
            const [r, c] = key.split('_').map(Number);
            compute(r, c);
        }
        return computed;
    }
    const [rowSt, rowEd, colSt, colEd] = range;
    for (let r = rowSt; r <= rowEd; r += 1) {
        if (cfg.rowhidden?.[r] != null) continue;
        for (let c = colSt; c <= colEd; c += 1) {
            if (cfg.colhidden?.[c] != null) continue;
            compute(r, c);
        }
    }
    return computed;
}

// Per-side writes keep the sync patch granular; only a cell's first side creates its key.
function setSide(map: Record<string, CellBorderSides>, r: number, c: number, key: BorderSideKey, side: BorderSide) {
    (map[`${r}_${c}`] ??= {})[key] = { style: side.style, color: side.color };
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
    if (sides) map[`${r}_${c}`] = cloneDeep(sides);
    else delete map[`${r}_${c}`];
}

export function clearSides(
    map: Record<string, CellBorderSides>,
    rowSt: number,
    rowEd: number,
    colSt: number,
    colEd: number,
) {
    // Select-all on a tall sheet is a million-cell rectangle over a near-empty map; a
    // one-cell paste into a huge map is the reverse. Walk whichever is smaller.
    const keys = Object.keys(map);
    if (keys.length < (rowEd - rowSt + 1) * (colEd - colSt + 1)) {
        for (const key of keys) {
            const [r, c] = key.split('_').map(Number);
            if (r >= rowSt && r <= rowEd && c >= colSt && c <= colEd) delete map[key];
        }
        return;
    }
    for (let r = rowSt; r <= rowEd; r += 1) {
        for (let c = colSt; c <= colEd; c += 1) {
            delete map[`${r}_${c}`];
        }
    }
}

// Expands a toolbar layout into the cells' own sides. A border belongs to the cell it was
// drawn on — nothing is mirrored onto the neighbour across the shared edge, which would
// create the neighbour's key as one whole-object add and clobber a peer's write to it.
export function applyBorder(cfg: SheetConfig, type: BorderType, side: BorderSide, ranges: Selection[]) {
    const map = (cfg.borderInfo ??= {});
    for (const { row, column } of ranges) {
        const [r1, r2] = row;
        const [c1, c2] = column;
        for (let r = r1; r <= r2; r += 1) {
            for (let c = c1; c <= c2; c += 1) {
                switch (type) {
                    case 'border-all':
                        setSide(map, r, c, 'l', side);
                        setSide(map, r, c, 'r', side);
                        setSide(map, r, c, 't', side);
                        setSide(map, r, c, 'b', side);
                        break;
                    case 'border-slash':
                        setSide(map, r, c, 's', side);
                        break;
                    case 'border-outside':
                        if (r === r1) setSide(map, r, c, 't', side);
                        if (r === r2) setSide(map, r, c, 'b', side);
                        if (c === c1) setSide(map, r, c, 'l', side);
                        if (c === c2) setSide(map, r, c, 'r', side);
                        break;
                    case 'border-inside':
                        // Inner edges expressed once, as the top/left side of the cell below/right.
                        if (r > r1) setSide(map, r, c, 't', side);
                        if (c > c1) setSide(map, r, c, 'l', side);
                        break;
                    case 'border-horizontal':
                        // First row takes the edge below it, last row the edge above, inner rows
                        // both — so a single-row range still gets a bottom edge.
                        if (r === r1) setSide(map, r, c, 'b', side);
                        else if (r === r2) setSide(map, r, c, 't', side);
                        else {
                            setSide(map, r, c, 't', side);
                            setSide(map, r, c, 'b', side);
                        }
                        break;
                    case 'border-vertical':
                        if (c === c1) setSide(map, r, c, 'r', side);
                        else if (c === c2) setSide(map, r, c, 'l', side);
                        else {
                            setSide(map, r, c, 'l', side);
                            setSide(map, r, c, 'r', side);
                        }
                        break;
                    case 'border-left':
                        if (c === c1) setSide(map, r, c, 'l', side);
                        break;
                    case 'border-right':
                        if (c === c2) setSide(map, r, c, 'r', side);
                        break;
                    case 'border-top':
                        if (r === r1) setSide(map, r, c, 't', side);
                        break;
                    case 'border-bottom':
                        if (r === r2) setSide(map, r, c, 'b', side);
                        break;
                    case 'border-none':
                        // The outside neighbours lose their facing side too, so the shared
                        // edges go fully blank.
                        delete map[`${r}_${c}`];
                        if (r === r1) removeSide(map, r1 - 1, c, 'b');
                        if (r === r2) removeSide(map, r2 + 1, c, 't');
                        if (c === c1) removeSide(map, r, c1 - 1, 'r');
                        if (c === c2) removeSide(map, r, c2 + 1, 'l');
                        break;
                }
            }
        }
    }
}
