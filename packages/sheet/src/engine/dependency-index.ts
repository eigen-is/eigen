// The reverse dependency index: for a cell, the formulas that read it. A formula graph fills one through set and asks
// it dependentsOf for each cell that changed or holds a formula. A single cell gets an exact bucket. A range is listed
// in each 64 × 16 block it meets, so a lookup scans only the ranges near its cell. A range that runs down a whole
// column is listed once per column instead, and one across a whole row once per row. It counts the slots it lists, so
// a graph can hold an untrusted workbook to a budget as it changes.

import { LAST_COLUMN, LAST_ROW } from './formula-utils';
import type { FormulaDependency } from './types';

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
type Buckets = Map<string, Map<number, Set<RangeEntry>>>;

const ROW_BLOCK = 64;
const COL_BLOCK = 16;

// Cells pack into one number: fine for any r < 2^33 since c < 2^20 in practice.
const CELL_PACK = 1 << 20;
const BLOCK_PACK = 1 << 16;

// The rows from which a range costs fewer slots in its columns than in its blocks, as columns do in its rows.
const LONG_RANGE = ROW_BLOCK * COL_BLOCK;

// A dependency's sheet and cells, its corners in order and inside Excel's grid, as `A:ZZZZZZ` may run past it; null
// when it names no sheet.
export function cellsOf(
    dep: FormulaDependency,
): { sheetId: string; r0: number; r1: number; c0: number; c1: number } | null {
    if (dep.sheetId == null) return null;
    return {
        sheetId: dep.sheetId,
        r0: Math.max(0, Math.min(dep.row[0], dep.row[1])),
        r1: Math.min(LAST_ROW, Math.max(0, dep.row[0], dep.row[1])),
        c0: Math.max(0, Math.min(dep.column[0], dep.column[1])),
        c1: Math.min(LAST_COLUMN, Math.max(0, dep.column[0], dep.column[1])),
    };
}

// One number for a cell of a sheet, as the index and a graph's cell lookup key it.
export function packCell(r: number, c: number): number {
    return r * CELL_PACK + c;
}

export class DependencyIndex {
    private readonly points = new Map<string, Map<number, Set<string>>>();
    private readonly buckets: Record<Layout, Buckets> = { blocks: new Map(), columns: new Map(), rows: new Map() };
    private readonly byKey = new Map<string, { entries: KeyedEntry[]; slots: number }>();
    private listedSlots = 0;

    // The slots the listed ranges take, a single cell costing none.
    public get slots(): number {
        return this.listedSlots;
    }

    public set(key: string, deps: readonly FormulaDependency[]): void {
        this.delete(key);

        const stored: KeyedEntry[] = [];
        let slots = 0;
        for (const dep of deps) {
            const cells = cellsOf(dep);
            if (cells == null) continue;
            const { sheetId, r0, r1, c0, c1 } = cells;

            if (r0 === r1 && c0 === c1) {
                const point = packCell(r0, c0);
                let sheetPoints = this.points.get(sheetId);
                if (sheetPoints == null) {
                    sheetPoints = new Map();
                    this.points.set(sheetId, sheetPoints);
                }
                const keys = sheetPoints.get(point);
                // `=A1+A1` lists its formula once.
                if (keys == null) sheetPoints.set(point, new Set([key]));
                else if (keys.has(key)) continue;
                else keys.add(key);
                stored.push({ sheetId, point });
            } else {
                const entry: RangeEntry = { r0, r1, c0, c1, key };
                const layout = layoutOf(cells);
                let ranges = this.buckets[layout].get(sheetId);
                if (ranges == null) {
                    ranges = new Map();
                    this.buckets[layout].set(sheetId, ranges);
                }
                const sheetRanges = ranges;
                forEachSlot(entry, layout, (slot) => {
                    const entries = sheetRanges.get(slot);
                    if (entries == null) sheetRanges.set(slot, new Set([entry]));
                    else entries.add(entry);
                    slots += 1;
                });
                stored.push({ sheetId, entry, layout });
            }
        }

        if (stored.length === 0) return;
        this.byKey.set(key, { entries: stored, slots });
        this.listedSlots += slots;
    }

    public delete(key: string): void {
        const stored = this.byKey.get(key);
        if (stored == null) return;
        this.byKey.delete(key);
        this.listedSlots -= stored.slots;

        for (const item of stored.entries) {
            if ('point' in item) {
                const sheetPoints = this.points.get(item.sheetId);
                const keys = sheetPoints?.get(item.point);
                keys?.delete(key);
                if (keys?.size === 0) sheetPoints?.delete(item.point);
            } else {
                const sheetRanges = this.buckets[item.layout].get(item.sheetId);
                if (sheetRanges == null) continue;
                forEachSlot(item.entry, item.layout, (slot) => {
                    const entries = sheetRanges.get(slot);
                    entries?.delete(item.entry);
                    if (entries?.size === 0) sheetRanges.delete(slot);
                });
            }
        }
    }

    // Keys of formulas whose dependency ranges cover (r, c).
    public dependentsOf(sheetId: string, r: number, c: number): string[] {
        const found = new Set<string>(this.points.get(sheetId)?.get(packCell(r, c)));
        for (const entries of this.nearby(sheetId, r, c)) {
            for (const entry of entries ?? []) {
                if (r >= entry.r0 && r <= entry.r1 && c >= entry.c0 && c <= entry.c1) found.add(entry.key);
            }
        }
        return [...found];
    }

    // How many entries dependentsOf visits for (r, c), a range near it counted whether it covers the cell or not.
    // Counted without a scan, so a walk can weigh the scan before it runs.
    public lookupVisits(sheetId: string, r: number, c: number): number {
        let visits = this.points.get(sheetId)?.get(packCell(r, c))?.size ?? 0;
        for (const entries of this.nearby(sheetId, r, c)) visits += entries?.size ?? 0;
        return visits;
    }

    // The ranges listed in the block, the column and the row of (r, c).
    private nearby(sheetId: string, r: number, c: number): (Set<RangeEntry> | undefined)[] {
        return [
            this.buckets.blocks.get(sheetId)?.get(Math.floor(r / ROW_BLOCK) * BLOCK_PACK + Math.floor(c / COL_BLOCK)),
            this.buckets.columns.get(sheetId)?.get(c),
            this.buckets.rows.get(sheetId)?.get(r),
        ];
    }
}

// A range to the grid's last row, or a long one from the top, is listed in its columns, and likewise along the rows.
// A lookup there also scans the ranges that end above its cell, so any other range goes by blocks to keep it near.
function layoutOf({ r0, r1, c0, c1 }: { r0: number; r1: number; c0: number; c1: number }): Layout {
    if (r1 >= LAST_ROW || (r0 === 0 && r1 >= LONG_RANGE)) return 'columns';
    if (c1 >= LAST_COLUMN || (c0 === 0 && c1 >= LONG_RANGE)) return 'rows';
    return 'blocks';
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
