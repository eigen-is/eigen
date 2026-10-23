import { CHART_MAX_SIDE } from '../charts/spec';
import { generateKeyBetween, orderByFractionalIndex, syncInvalidIndices } from '../vector/fractional-index';
import type { Box } from '../vector/geometry';
import {
    REFERENCE_COLUMN_COUNT,
    REFERENCE_ROW_COUNT,
    SHEET_DEFAULT_COL_WIDTH,
    SHEET_DEFAULT_ROW_HEIGHT,
} from './defaults';
import type { Sheet, SheetChart, SheetFloatingObject, SheetImage } from './types';

export type SheetFloatingKind = 'image' | 'chart';
export type SheetFloatingItem = { kind: 'image'; object: SheetImage } | { kind: 'chart'; object: SheetChart };

// A sheet's images and charts in one paint order, bottom first: the editor's overlay, the export and a z-order move read it.
export function floatingItems(sheet: Sheet): SheetFloatingItem[] {
    const items: SheetFloatingItem[] = [
        ...Object.values(sheet.images ?? {}).map((object) => ({ kind: 'image' as const, object })),
        ...Object.values(sheet.charts ?? {}).map((object) => ({ kind: 'chart' as const, object })),
    ];
    return orderByFractionalIndex(items.map((item) => ({ id: item.object.id, index: item.object.index, item }))).map(
        ({ item }) => item,
    );
}

// A sheet's `images` or `charts` as the editor writes it. Before images became a map they were stored, and an older
// tab still writes them, as one array, which no per-object write resolves on: readers drop it.
export function isFloatingMap(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// The index of an object inserted above every image and chart. Tied and malformed keys, which concurrent inserts and
// files leave behind, are repaired on the sheet's own records first, so the caller writes the repair with its insert, as
// a z-order move does: generateKeyBetween throws on them, and a malformed key such as 'zz' still sorts above any key
// the insert could take.
export function nextFloatingIndex(sheet: Sheet): string {
    const objects = syncInvalidIndices(floatingItems(sheet).map(({ object }) => object));
    return generateKeyBetween(objects.at(-1)?.index ?? null, null);
}

// Excel's grid at the default track sizes: an object's corner lies on it.
const GRID_WIDTH = REFERENCE_COLUMN_COUNT * SHEET_DEFAULT_COL_WIDTH;
const GRID_HEIGHT = REFERENCE_ROW_COUNT * SHEET_DEFAULT_ROW_HEIGHT;

// An image's or chart's box as the editor's writers and the xlsx import store it and every painter draws it. A file or
// a peer can store any value, a string included, and a side past CHART_MAX_SIDE, the largest page, stalls every
// painter, at a trillion px overflowing its stack.
export function sheetFloatingBox({ x, y, width, height, angle }: Omit<SheetFloatingObject, 'id' | 'index'>): Box {
    const degrees = Number(angle ?? 0);
    return {
        x: within(x, 0, GRID_WIDTH),
        y: within(y, 0, GRID_HEIGHT),
        width: within(width, 1, CHART_MAX_SIDE),
        height: within(height, 1, CHART_MAX_SIDE),
        angle: Number.isFinite(degrees) ? degrees : 0,
    };
}

function within(value: number, min: number, max: number): number {
    const clamped = Math.min(max, Math.max(min, Number(value)));
    return Number.isNaN(clamped) ? min : clamped;
}
