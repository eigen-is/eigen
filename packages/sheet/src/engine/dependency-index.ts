// The reverse dependency index: for a cell, the formulas that read it. The editor's formula map and the server's
// recalc both fill one, through set, and ask it dependentsOf for each cell that changed or holds a formula. A single
// cell gets an exact bucket. A range is listed in each 64 × 16 block it meets, so a lookup scans only the ranges near
// its cell. A range down every row of its sheet, such as a whole column, is listed once per column instead, and one
// across every column once per row.

import type { FormulaDependency } from './types';

// A sheet's size, which tells set whether a range runs down every row or across every column.
export type SheetExtent = { rows: number; columns: number };

type ExtentOf = (sheetId: string) => SheetExtent | undefined;

type RangeEntry = {
    r0: number;
    r1: number;
    c0: number;
    c1: number;
    key: string;
};

// Where set lists a range: in the blocks it meets, in its columns, or in its rows.
type Layout = 'blocks' | 'columns' | 'rows';

type KeyedEntry = { sheetId: string; point: number } | { sheetId: string; entry: RangeEntry; layout: Layout };

// Per sheet, the ranges listed under each block, column or row number.
type Buckets = Map<string, Map<number, RangeEntry[]>>;

const ROW_BLOCK = 64;
const COL_BLOCK = 16;

// Cells pack into one number: fine for any r < 2^33 since c < 2^20 in practice.
const CELL_PACK = 1 << 20;
const BLOCK_PACK = 1 << 16;

const EMPTY: readonly string[] = [];

// A dependency's sheet and cells, its corners in order and none below 0; null when it names no sheet.
export function cellsOf(
    dep: FormulaDependency,
): { sheetId: string; r0: number; r1: number; c0: number; c1: number } | null {
    if (dep.sheetId == null) return null;
    return {
        sheetId: dep.sheetId,
        r0: Math.max(0, Math.min(dep.row[0], dep.row[1])),
        r1: Math.max(0, dep.row[0], dep.row[1]),
        c0: Math.max(0, Math.min(dep.column[0], dep.column[1])),
        c1: Math.max(0, dep.column[0], dep.column[1]),
    };
}

// The slots set lists a formula's ranges in, a single cell costing none: what recalc charges an untrusted workbook's
// formulas before the index holds them.
export function dependencyBlocks(deps: readonly FormulaDependency[], extentOf: ExtentOf): number {
    let slots = 0;
    for (const dep of deps) {
        const cells = cellsOf(dep);
        if (cells == null || (cells.r0 === cells.r1 && cells.c0 === cells.c1)) continue;
        slots += layoutOf(cells, extentOf(cells.sheetId)).slots;
    }
    return slots;
}

export class DependencyIndex {
    private points = new Map<string, Map<number, string[]>>();
    private buckets: Record<Layout, Buckets> = { blocks: new Map(), columns: new Map(), rows: new Map() };
    private byKey = new Map<string, KeyedEntry[]>();
    private queryCache = new Map<string, Map<number, readonly string[]>>();

    public set(key: string, deps: readonly FormulaDependency[], extentOf: ExtentOf): void {
        this.delete(key);

        const stored: KeyedEntry[] = [];
        for (const dep of deps) {
            const cells = cellsOf(dep);
            if (cells == null) continue;
            const { sheetId, r0, r1, c0, c1 } = cells;

            if (r0 === r1 && c0 === c1) {
                const point = r0 * CELL_PACK + c0;
                let sheetPoints = this.points.get(sheetId);
                if (sheetPoints == null) {
                    sheetPoints = new Map();
                    this.points.set(sheetId, sheetPoints);
                }
                const keys = sheetPoints.get(point);
                // One entry per formula: `delete` splices a single occurrence, so a formula reading the same cell
                // twice (`=A1+A1`) must not be listed twice.
                if (keys == null) sheetPoints.set(point, [key]);
                else if (!keys.includes(key)) keys.push(key);
                stored.push({ sheetId, point });
            } else {
                const entry: RangeEntry = { r0, r1, c0, c1, key };
                const { layout } = layoutOf(cells, extentOf(sheetId));
                let sheetBuckets = this.buckets[layout].get(sheetId);
                if (sheetBuckets == null) {
                    sheetBuckets = new Map();
                    this.buckets[layout].set(sheetId, sheetBuckets);
                }
                const ranges = sheetBuckets;
                forEachSlot(entry, layout, (slot) => {
                    const entries = ranges.get(slot);
                    if (entries == null) ranges.set(slot, [entry]);
                    else entries.push(entry);
                });
                stored.push({ sheetId, entry, layout });
            }
        }

        if (stored.length > 0) this.byKey.set(key, stored);
        this.queryCache.clear();
    }

    public delete(key: string): void {
        const stored = this.byKey.get(key);
        if (stored == null) return;
        this.byKey.delete(key);

        for (const item of stored) {
            if ('point' in item) {
                const sheetPoints = this.points.get(item.sheetId);
                const keys = sheetPoints?.get(item.point);
                if (sheetPoints == null || keys == null) continue;
                if (keys.length === 1) {
                    sheetPoints.delete(item.point);
                } else {
                    const at = keys.indexOf(key);
                    if (at !== -1) keys.splice(at, 1);
                }
            } else {
                const sheetBuckets = this.buckets[item.layout].get(item.sheetId);
                if (sheetBuckets == null) continue;
                forEachSlot(item.entry, item.layout, (slot) => {
                    const entries = sheetBuckets.get(slot);
                    if (entries == null) return;
                    const at = entries.indexOf(item.entry);
                    if (at === -1) return;
                    if (entries.length === 1) sheetBuckets.delete(slot);
                    else entries.splice(at, 1);
                });
            }
        }
        this.queryCache.clear();
    }

    public clear(): void {
        this.points.clear();
        for (const buckets of Object.values(this.buckets)) buckets.clear();
        this.byKey.clear();
        this.queryCache.clear();
    }

    // Keys of formulas whose dependency ranges cover (r, c). Results are cached until the next mutation, so callers
    // must not change the returned array.
    public dependentsOf(sheetId: string, r: number, c: number): readonly string[] {
        const packed = r * CELL_PACK + c;
        let sheetCache = this.queryCache.get(sheetId);
        const cached = sheetCache?.get(packed);
        if (cached != null) return cached;

        const pointKeys = this.points.get(sheetId)?.get(packed);
        const nearby = [
            this.buckets.blocks.get(sheetId)?.get(blockOf(r, c)),
            this.buckets.columns.get(sheetId)?.get(c),
            this.buckets.rows.get(sheetId)?.get(r),
        ];

        // With no range nearby the point bucket is the answer. It is safe to hand out, because every change to it
        // clears the query cache.
        let result = pointKeys ?? EMPTY;
        if (nearby.some((entries) => entries != null)) {
            const found = new Set<string>(pointKeys);
            for (const entries of nearby) {
                for (const entry of entries ?? []) {
                    if (r >= entry.r0 && r <= entry.r1 && c >= entry.c0 && c <= entry.c1) found.add(entry.key);
                }
            }
            result = found.size === 0 ? EMPTY : [...found];
        }

        if (sheetCache == null) {
            sheetCache = new Map();
            this.queryCache.set(sheetId, sheetCache);
        }
        sheetCache.set(packed, result);
        return result;
    }
}

// The cheapest of the layouts that fit a range, and the slots it takes there. Only a range down every row of its
// sheet may go in its columns, and only one across every column in its rows. A lookup in such a column or row then
// finds every range listed there, so it scans nothing it doesn't return.
function layoutOf(
    cells: { r0: number; r1: number; c0: number; c1: number },
    extent: SheetExtent | undefined,
): { layout: Layout; slots: number } {
    const { r0, r1, c0, c1 } = cells;
    let best: { layout: Layout; slots: number } = {
        layout: 'blocks',
        slots:
            (Math.floor(r1 / ROW_BLOCK) - Math.floor(r0 / ROW_BLOCK) + 1) *
            (Math.floor(c1 / COL_BLOCK) - Math.floor(c0 / COL_BLOCK) + 1),
    };
    if (extent == null) return best;
    if (r0 === 0 && r1 >= extent.rows - 1 && c1 - c0 + 1 < best.slots) {
        best = { layout: 'columns', slots: c1 - c0 + 1 };
    }
    if (c0 === 0 && c1 >= extent.columns - 1 && r1 - r0 + 1 < best.slots) {
        best = { layout: 'rows', slots: r1 - r0 + 1 };
    }
    return best;
}

function forEachSlot(entry: RangeEntry, layout: Layout, fn: (slot: number) => void): void {
    if (layout === 'columns') {
        for (let c = entry.c0; c <= entry.c1; c += 1) fn(c);
    } else if (layout === 'rows') {
        for (let r = entry.r0; r <= entry.r1; r += 1) fn(r);
    } else {
        for (let rb = Math.floor(entry.r0 / ROW_BLOCK); rb <= Math.floor(entry.r1 / ROW_BLOCK); rb += 1) {
            for (let cb = Math.floor(entry.c0 / COL_BLOCK); cb <= Math.floor(entry.c1 / COL_BLOCK); cb += 1) {
                fn(rb * BLOCK_PACK + cb);
            }
        }
    }
}

function blockOf(r: number, c: number): number {
    return Math.floor(r / ROW_BLOCK) * BLOCK_PACK + Math.floor(c / COL_BLOCK);
}
