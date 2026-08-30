import type { BorderSide, BorderType, CellBorderSides, MergeCell } from '@workspace/lib/sheets';
import { cloneDeep, isEmpty } from 'es-toolkit/compat';
import type { CellMatrix } from '../../engine/types';
import { type Context, getFlowdata, getSheetConfig } from '../context';
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

// A cell's own stored sides, as the painter should draw them. Storage stays raw so an
// unmerge shows a merged constituent's borders again; here only the sides on the merge's
// outer edge survive, and the diagonal is the master's (drawn with the merged extent).
function visibleSides(cfg: SheetConfig, data: CellMatrix, r: number, c: number): CellBorderSides | undefined {
    const stored = cfg.borderInfo?.[`${r}_${c}`];
    if (!stored || cfg.rowhidden?.[r] != null || cfg.colhidden?.[c] != null) return undefined;

    const anchor = data[r]?.[c]?.mc;
    const mc: MergeCell | undefined = anchor && cfg.merge?.[`${anchor.r}_${anchor.c}`];
    if (!mc) return stored;

    const sides: CellBorderSides = {};
    if (stored.l && c === mc.c) sides.l = stored.l;
    if (stored.r && c === mc.c + mc.cs - 1) sides.r = stored.r;
    if (stored.t && r === mc.r) sides.t = stored.t;
    if (stored.b && r === mc.r + mc.rs - 1) sides.b = stored.b;
    if (stored.s && r === mc.r && c === mc.c) sides.s = stored.s;
    return Object.keys(sides).length > 0 ? sides : undefined;
}

function sheetSlice(ctx: Context, sheetId?: string): { cfg: SheetConfig; data: CellMatrix } | undefined {
    if (sheetId === undefined) {
        const cfg = getSheetConfig(ctx);
        const data = getFlowdata(ctx);
        return cfg && data ? { cfg, data } : undefined;
    }
    const index = getSheetIndex(ctx, sheetId);
    if (index == null) return undefined;
    const { config, data } = ctx.sheets[index];
    return config && data ? { cfg: config, data } : undefined;
}

// Walks the visible cells rather than the map: this runs every scroll frame and a large
// workbook stores hundreds of thousands of entries.
export function getBorderInfoComputeRange(
    ctx: Context,
    rowSt: number,
    rowEd: number,
    colSt: number,
    colEd: number,
    sheetId?: string,
): Record<string, CellBorderSides> {
    const computed: Record<string, CellBorderSides> = {};
    const slice = sheetSlice(ctx, sheetId);
    if (!slice || isEmpty(slice.cfg.borderInfo)) return computed;

    for (let r = rowSt; r <= rowEd; r += 1) {
        for (let c = colSt; c <= colEd; c += 1) {
            const sides = visibleSides(slice.cfg, slice.data, r, c);
            if (sides) computed[`${r}_${c}`] = sides;
        }
    }
    return computed;
}

export function getBorderInfoCompute(ctx: Context, sheetId?: string): Record<string, CellBorderSides> {
    const computed: Record<string, CellBorderSides> = {};
    const slice = sheetSlice(ctx, sheetId);
    if (!slice) return computed;

    for (const key of Object.keys(slice.cfg.borderInfo ?? {})) {
        const sepIdx = key.indexOf('_');
        const sides = visibleSides(slice.cfg, slice.data, Number(key.slice(0, sepIdx)), Number(key.slice(sepIdx + 1)));
        if (sides) computed[key] = sides;
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
