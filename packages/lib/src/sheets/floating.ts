// A sheet's floating images and charts: one paint order for both, the box every painter draws, the index an insert
// takes, and the count of a chart's entries its cap is checked against. The editor's overlay, the exports and the
// batch apply read them, so every reader orders, draws and bounds the objects alike.

import { CHART_MAX_SIDE, MAX_CHART_SPEC_ENTRIES } from '../charts/limits';
import { isRecord } from '../core/guards';
import { generateKeyBetween, orderByFractionalIndex, syncInvalidIndices } from '../vector/fractional-index';
import type { Box } from '../vector/geometry';
import {
    REFERENCE_COLUMN_COUNT,
    REFERENCE_ROW_COUNT,
    SHEET_DEFAULT_COL_WIDTH,
    SHEET_DEFAULT_ROW_HEIGHT,
} from './defaults';
import type { Sheet, SheetChart, SheetFloatingObject, SheetImage } from './types';

export type SheetFloatingItem = { kind: 'image'; object: SheetImage } | { kind: 'chart'; object: SheetChart };
export type SheetFloatingKind = SheetFloatingItem['kind'];

// A sheet's images and charts in one paint order, bottom first: the editor's overlay, the export and a z-order move read it.
// A peer can store anything under an id, so an entry that is no object is no image or chart.
export function floatingItems(sheet: Sheet): SheetFloatingItem[] {
    const items: SheetFloatingItem[] = [
        ...Object.values(sheet.images ?? {})
            .filter((object) => isRecord(object))
            .map((object) => ({ kind: 'image' as const, object })),
        ...Object.values(sheet.charts ?? {})
            .filter((object) => isRecord(object))
            .map((object) => ({ kind: 'chart' as const, object })),
    ];
    return orderByFractionalIndex(items.map((item) => ({ id: item.object.id, index: item.object.index, item }))).map(
        ({ item }) => item,
    );
}

// A chart's keys and those of every record it holds: its keyed parts' entries, and any other key a peer stored.
export function chartEntries(chart: unknown): number {
    if (!isRecord(chart)) return 0;
    let count = Object.keys(chart).length;
    for (const value of Object.values(chart)) if (isRecord(value)) count += Object.keys(value).length;
    return count;
}

const chartFits = (chart: unknown) => chartEntries(chart) <= MAX_CHART_SPEC_ENTRIES;

// A sheet's charts as a snapshot or a whole sheet brings them, past every write's own check: a chart past
// MAX_CHART_SPEC_ENTRIES is left out, so no read lists its keys. The map itself when every chart fits.
export function chartsWithinEntryCap<C>(charts: Record<string, C>): Record<string, C> {
    if (Object.values(charts).every(chartFits)) return charts;
    return Object.fromEntries(Object.entries(charts).filter(([, chart]) => chartFits(chart)));
}

// The index of an object inserted above every image and chart. It repairs tied and malformed keys on the sheet's own
// records first, for the caller to write with its insert: generateKeyBetween throws on them.
export function nextFloatingIndex(sheet: Sheet): string {
    const objects = syncInvalidIndices(floatingItems(sheet).map(({ object }) => object));
    return generateKeyBetween(objects.at(-1)?.index ?? null, null);
}

// Excel's grid at the default track sizes: an object's corner lies on it.
const GRID_WIDTH = REFERENCE_COLUMN_COUNT * SHEET_DEFAULT_COL_WIDTH;
const GRID_HEIGHT = REFERENCE_ROW_COUNT * SHEET_DEFAULT_ROW_HEIGHT;

// An image's or chart's box as every writer stores it and every painter draws it. A file or a peer can store any
// value, a string included, and a side past CHART_MAX_SIDE stalls every painter.
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
