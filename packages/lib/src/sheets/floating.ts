import { CHART_MAX_SIDE, MAX_CHART_SPEC_ENTRIES } from '../charts/spec';
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
export function floatingItems(sheet: Sheet): SheetFloatingItem[] {
    const items: SheetFloatingItem[] = [
        ...Object.values(sheet.images ?? {}).map((object) => ({ kind: 'image' as const, object })),
        ...Object.values(sheet.charts ?? {}).map((object) => ({ kind: 'chart' as const, object })),
    ];
    return orderByFractionalIndex(items.map((item) => ({ id: item.object.id, index: item.object.index, item }))).map(
        ({ item }) => item,
    );
}

type SheetWrite = { op: string; path: (string | number)[]; value?: unknown };
type FloatingMaps = Partial<Record<'images' | 'charts', Record<string, unknown>>>;

// Which writes of one batch apply, asked in order. A write into a field of an image or chart applies when the object
// is there as the batch's earlier writes leave it, else as it stood before the batch: one a peer deleted resolves on
// nothing, so every client, the replay and an undo or redo drop just that write and the rest of the batch applies. An
// insert whose index repair names a tied object a peer deleted keeps its insert; a merged gesture's undo that puts an
// object back and then its field keeps the field. A chart's entry write applies on a record field only, and no write
// leaves a chart holding more than MAX_CHART_SPEC_ENTRIES. Paths are Sheet[]-rooted, the sheet's index first.
export function floatingWriteFilter(sheets: Sheet[]): (write: SheetWrite) => boolean {
    const written = new Map<number, FloatingMaps>();
    const mapsOf = (sheet: number) => {
        let maps = written.get(sheet);
        if (!maps) written.set(sheet, (maps = copyFloatingMaps(sheets[sheet])));
        return maps;
    };
    // The charts and records this batch wrote into, copies of what the sheets hold, with their entries counted.
    const copies = new WeakSet<object>();
    const counts = new WeakMap<object, number>();
    const own = (record: Record<string, unknown>) => {
        if (copies.has(record)) return record;
        const copy = { ...record };
        copies.add(copy);
        return copy;
    };
    // A chart's field, or an entry of a field that is a record: an entry is a string, so nothing deeper resolves.
    const chartWrite = (charts: Record<string, unknown>, id: string, op: string, rest: unknown[], value: unknown) => {
        const [key, entry, ...deeper] = rest;
        const stored = charts[id];
        if (!isRecord(stored) || !isKey(key) || deeper.length > 0) return false;
        const field = stored[key];
        let record: Record<string, unknown> | undefined;
        if (entry !== undefined) {
            if (!isRecord(field) || !isKey(entry)) return false;
            record = field;
        }
        const at = entry ?? key;
        const kept = op !== 'remove';
        const held = record ? 0 : (kept ? recordEntries(value) : 0) - recordEntries(field);
        const next =
            (counts.get(stored) ?? chartEntries(stored)) +
            Number(kept) -
            Number(Object.hasOwn(record ?? stored, at)) +
            held;
        if (next > MAX_CHART_SPEC_ENTRIES) return false;
        const chart = own(stored);
        const target = record ? own(record) : chart;
        if (kept) target[at] = value;
        else delete target[at];
        if (target !== chart) chart[key] = target;
        counts.set(chart, next);
        charts[id] = chart;
        return true;
    };
    return ({ op, path: [sheet, field, id, ...rest], value }) => {
        if (typeof sheet !== 'number') return true;
        if (field === undefined) {
            if (op !== 'remove' && isRecord(value) && !chartsFit(value['charts'])) return false;
            written.set(sheet, op === 'remove' ? {} : copyFloatingMaps(value));
            return true;
        }
        if (field !== 'images' && field !== 'charts') return true;
        const maps = mapsOf(sheet);
        if (id === undefined) {
            if (field === 'charts' && op !== 'remove' && !chartsFit(value)) return false;
            maps[field] = op === 'remove' || !isRecord(value) ? undefined : { ...value };
        } else if (rest.length > 0) {
            const objects = maps[field];
            if (objects?.[id] == null) return false;
            return field === 'images' || chartWrite(objects, String(id), op, rest, value);
        } else if (op === 'remove') delete maps[field]?.[id];
        else if (field === 'charts' && !chartFits(value)) return false;
        else (maps[field] ??= {})[id] = value;
        return true;
    };
}

// A chart's keys and those of every record it holds: its keyed parts' entries, and any other key a peer stored.
function chartEntries(chart: Record<string, unknown>): number {
    let count = Object.keys(chart).length;
    for (const value of Object.values(chart)) count += recordEntries(value);
    return count;
}

const recordEntries = (value: unknown) => (isRecord(value) ? Object.keys(value).length : 0);
const isKey = (key: unknown): key is string | number => typeof key === 'string' || typeof key === 'number';
const chartFits = (chart: unknown) => !isRecord(chart) || chartEntries(chart) <= MAX_CHART_SPEC_ENTRIES;
const chartsFit = (charts: unknown) => !isRecord(charts) || Object.values(charts).every(chartFits);

// A sheet's charts as a snapshot or a whole sheet brings them, which no write passed through floatingWriteFilter: a
// chart past MAX_CHART_SPEC_ENTRIES is left out, so no read lists its keys. The map itself when every chart fits.
export function chartsWithinEntryCap<C>(charts: Record<string, C>): Record<string, C> {
    if (chartsFit(charts)) return charts;
    return Object.fromEntries(Object.entries(charts).filter(([, chart]) => chartFits(chart)));
}

function copyFloatingMaps(sheet: unknown): FloatingMaps {
    if (!isRecord(sheet)) return {};
    const { images, charts } = sheet;
    return {
        images: isRecord(images) ? { ...images } : undefined,
        charts: isRecord(charts) ? { ...charts } : undefined,
    };
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
