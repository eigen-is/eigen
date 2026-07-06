import type { FormulaDependency } from './types';

// Reverse dependency index: which formulas read a given cell. Single-cell
// dependencies (the vast majority — fill-down formulas like =D8*E8) get an
// exact per-cell bucket; multi-cell ranges are bucketed into fixed-size
// row/column blocks so a point query scans only the ranges near that cell
// instead of every formula in the workbook.
const ROW_BLOCK = 64;
const COL_BLOCK = 16;

// Cells pack into one number: fine for any r < 2^33 since c < 2^20 in practice.
const CELL_PACK = 1 << 20;
const BLOCK_PACK = 1 << 16;

type RangeEntry = {
    r0: number;
    r1: number;
    c0: number;
    c1: number;
    key: string;
};

type KeyedEntry = { sheetId: string; point: number } | { sheetId: string; entry: RangeEntry };

function forEachBlock(entry: RangeEntry, fn: (block: number) => void): void {
    for (let rb = Math.floor(entry.r0 / ROW_BLOCK); rb <= Math.floor(entry.r1 / ROW_BLOCK); rb += 1) {
        for (let cb = Math.floor(entry.c0 / COL_BLOCK); cb <= Math.floor(entry.c1 / COL_BLOCK); cb += 1) {
            fn(rb * BLOCK_PACK + cb);
        }
    }
}

const EMPTY: readonly string[] = [];

export class DependencyIndex {
    private points = new Map<string, Map<number, string[]>>();
    private ranges = new Map<string, Map<number, RangeEntry[]>>();
    private byKey = new Map<string, KeyedEntry[]>();
    private queryCache = new Map<string, Map<number, readonly string[]>>();

    set(key: string, deps: FormulaDependency[]): void {
        this.delete(key);

        const stored: KeyedEntry[] = [];
        for (const dep of deps) {
            const { sheetId } = dep;
            if (sheetId == null) continue;

            const r0 = Math.max(0, Math.min(dep.row[0], dep.row[1]));
            const r1 = Math.max(0, dep.row[0], dep.row[1]);
            const c0 = Math.max(0, Math.min(dep.column[0], dep.column[1]));
            const c1 = Math.max(0, dep.column[0], dep.column[1]);

            if (r0 === r1 && c0 === c1) {
                const point = r0 * CELL_PACK + c0;
                let sheetPoints = this.points.get(sheetId);
                if (sheetPoints == null) {
                    sheetPoints = new Map();
                    this.points.set(sheetId, sheetPoints);
                }
                const keys = sheetPoints.get(point);
                if (keys == null) sheetPoints.set(point, [key]);
                else keys.push(key);
                stored.push({ sheetId, point });
            } else {
                const entry: RangeEntry = { r0, r1, c0, c1, key };
                let sheetRanges = this.ranges.get(sheetId);
                if (sheetRanges == null) {
                    sheetRanges = new Map();
                    this.ranges.set(sheetId, sheetRanges);
                }
                const ranges = sheetRanges;
                forEachBlock(entry, (block) => {
                    const entries = ranges.get(block);
                    if (entries == null) ranges.set(block, [entry]);
                    else entries.push(entry);
                });
                stored.push({ sheetId, entry });
            }
        }

        if (stored.length > 0) this.byKey.set(key, stored);
        this.queryCache.clear();
    }

    delete(key: string): void {
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
                const sheetRanges = this.ranges.get(item.sheetId);
                if (sheetRanges == null) continue;
                forEachBlock(item.entry, (block) => {
                    const entries = sheetRanges.get(block);
                    if (entries == null) return;
                    const at = entries.indexOf(item.entry);
                    if (at === -1) return;
                    if (entries.length === 1) sheetRanges.delete(block);
                    else entries.splice(at, 1);
                });
            }
        }
        this.queryCache.clear();
    }

    clear(): void {
        this.points.clear();
        this.ranges.clear();
        this.byKey.clear();
        this.queryCache.clear();
    }

    // Keys of formulas whose dependency ranges cover (r, c). Results are cached
    // until the next mutation; callers must not mutate the returned array.
    dependentsOf(sheetId: string, r: number, c: number): readonly string[] {
        const packed = r * CELL_PACK + c;
        let sheetCache = this.queryCache.get(sheetId);
        const cached = sheetCache?.get(packed);
        if (cached != null) return cached;

        const pointKeys = this.points.get(sheetId)?.get(packed);
        const blockEntries = this.ranges
            .get(sheetId)
            ?.get(Math.floor(r / ROW_BLOCK) * BLOCK_PACK + Math.floor(c / COL_BLOCK));

        let result: readonly string[];
        if (blockEntries == null) {
            // Point bucket only — return it directly (read-only contract, and the
            // query cache is cleared on every mutation of the bucket).
            result = pointKeys ?? EMPTY;
        } else {
            const found = new Set<string>(pointKeys);
            for (const entry of blockEntries) {
                if (r >= entry.r0 && r <= entry.r1 && c >= entry.c0 && c <= entry.c1) {
                    found.add(entry.key);
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
