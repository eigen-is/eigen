// The reverse dependency index: for a cell, the formulas that read it. The editor's formula map and the server's
// recalc both fill one, through set, and ask it dependentsOf for each cell that changed or holds a formula. A single
// cell gets an exact bucket. A range is listed in each 64 × 16 block it meets, so a lookup scans only the ranges near
// its cell. A range that runs down a whole column is listed once per column instead, and one across a whole row once
// per row.

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
type Buckets = Map<string, Map<number, RangeEntry[]>>;

const ROW_BLOCK = 64;
const COL_BLOCK = 16;

// Cells pack into one number: fine for any r < 2^33 since c < 2^20 in practice.
const CELL_PACK = 1 << 20;
const BLOCK_PACK = 1 << 16;

// The rows from which a range costs fewer slots in its columns than in its blocks, as columns do in its rows.
const LONG_RANGE = ROW_BLOCK * COL_BLOCK;

const EMPTY: readonly string[] = [];

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

// The slots set lists a formula's ranges in, a single cell costing none: what recalc charges an untrusted workbook's
// formulas before the index holds them.
export function dependencySlots(deps: readonly FormulaDependency[]): number {
    let slots = 0;
    for (const dep of deps) {
        const cells = cellsOf(dep);
        if (cells == null || (cells.r0 === cells.r1 && cells.c0 === cells.c1)) continue;
        const { r0, r1, c0, c1 } = cells;
        const layout = layoutOf(cells);
        if (layout === 'columns') slots += c1 - c0 + 1;
        else if (layout === 'rows') slots += r1 - r0 + 1;
        else {
            slots +=
                (Math.floor(r1 / ROW_BLOCK) - Math.floor(r0 / ROW_BLOCK) + 1) *
                (Math.floor(c1 / COL_BLOCK) - Math.floor(c0 / COL_BLOCK) + 1);
        }
    }
    return slots;
}

export class DependencyIndex {
    private points = new Map<string, Map<number, string[]>>();
    private buckets: Record<Layout, Buckets> = { blocks: new Map(), columns: new Map(), rows: new Map() };
    private byKey = new Map<string, KeyedEntry[]>();

    public set(key: string, deps: readonly FormulaDependency[]): void {
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
                // `=A1+A1` lists its formula once. The delete above took the key out, so a repeat is the last entry.
                if (keys == null) sheetPoints.set(point, [key]);
                else if (keys[keys.length - 1] !== key) keys.push(key);
                else continue;
                stored.push({ sheetId, point });
            } else {
                const entry: RangeEntry = { r0, r1, c0, c1, key };
                const layout = layoutOf(cells);
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
    }

    public clear(): void {
        this.points.clear();
        for (const buckets of Object.values(this.buckets)) buckets.clear();
        this.byKey.clear();
    }

    // Keys of formulas whose dependency ranges cover (r, c). With no range nearby that is the cell's own list, so a
    // caller must not change what it gets.
    public dependentsOf(sheetId: string, r: number, c: number): readonly string[] {
        const pointKeys = this.points.get(sheetId)?.get(r * CELL_PACK + c);
        const nearby = this.nearby(sheetId, r, c);
        if (!nearby.some((entries) => entries != null)) return pointKeys ?? EMPTY;
        const found = new Set<string>(pointKeys);
        for (const entries of nearby) {
            for (const entry of entries ?? []) {
                if (r >= entry.r0 && r <= entry.r1 && c >= entry.c0 && c <= entry.c1) found.add(entry.key);
            }
        }
        return found.size === 0 ? EMPTY : [...found];
    }

    // How many entries dependentsOf visits for (r, c), a range near it counted whether it covers the cell or not.
    // Counted without a scan, so recalc can weigh the scan before it runs.
    public lookupVisits(sheetId: string, r: number, c: number): number {
        let visits = this.points.get(sheetId)?.get(r * CELL_PACK + c)?.length ?? 0;
        for (const entries of this.nearby(sheetId, r, c)) visits += entries?.length ?? 0;
        return visits;
    }

    // How many formulas read (r, c), a formula that reads the cell through two of its ranges counted twice. It builds
    // nothing, so recalc can weigh the whole graph before it links it. It scans what lookupVisits counts.
    public countDependents(sheetId: string, r: number, c: number): number {
        let count = this.points.get(sheetId)?.get(r * CELL_PACK + c)?.length ?? 0;
        for (const entries of this.nearby(sheetId, r, c)) {
            for (const entry of entries ?? []) {
                if (r >= entry.r0 && r <= entry.r1 && c >= entry.c0 && c <= entry.c1) count += 1;
            }
        }
        return count;
    }

    // The ranges listed in the block, the column and the row of (r, c).
    private nearby(sheetId: string, r: number, c: number): (RangeEntry[] | undefined)[] {
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
