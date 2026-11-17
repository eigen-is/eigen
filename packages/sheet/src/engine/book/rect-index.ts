// Where rectangles lie on a sheet, such as the merges of a record type or the runs of one op, so a read finds the ones
// at a cell or on a screen without a walk of them all. A rectangle is listed in tiles of its own size, the smallest
// power of two rows and of two columns that hold its height and its width, so it lies in four tiles at most, and a
// read looks, per tile size in use, at the tiles it covers only. The records keep one by id; an op's read lists its
// runs by place, and walks the columns they cover once, through their hull.

import { GRID_COLUMNS } from '@workspace/formula/text';
import type { Rect } from '@workspace/lib/sheets/ops';
import { meets } from '@workspace/lib/sheets/rect';

// A tile holds two to these powers of rows and of columns at least, about as wide as it is tall on a screen.
const MIN_ROW_SHIFT = 4;
const MIN_COLUMN_SHIFT = 2;
// The most tiles side by side, which numbers a tile by its row of tiles and its place in it.
const TILES_ACROSS = GRID_COLUMNS >> MIN_COLUMN_SHIFT;

type Tile = Map<string, Rect[]>;

export class RectIndex {
    // By tile size, then by tile, then by id: the rectangles of that size with a cell in the tile.
    private readonly sizes = new Map<number, Map<number, Tile>>();

    // The rectangles of a list, each by its place in it as its id.
    public static of(rects: readonly Rect[]): RectIndex {
        const index = new RectIndex();
        for (const [at, rect] of rects.entries()) index.set(String(at), undefined, [rect]);
        return index;
    }

    // The rectangles with a cell in this one, each once with its id, in no order.
    public meeting(rect: Rect): [id: string, rect: Rect][] {
        const found: [string, Rect][] = [];
        for (const [size, tiles] of this.sizes) {
            const rowShift = size >> 4;
            const columnShift = size & 15;
            const top = rect[0] >> rowShift;
            const left = rect[1] >> columnShift;
            const bottom = rect[2] >> rowShift;
            const right = rect[3] >> columnShift;
            // A rectangle in several tiles is listed from the first of them the read covers.
            const list = (tile: Tile, key: number) => {
                for (const [id, rects] of tile) {
                    for (const held of rects) {
                        const first =
                            Math.max(held[0] >> rowShift, top) * TILES_ACROSS + Math.max(held[1] >> columnShift, left);
                        if (first === key && meets(held, rect)) found.push([id, held]);
                    }
                }
            };
            // A read of more tiles than hold a rectangle walks those instead.
            if ((bottom - top + 1) * (right - left + 1) > tiles.size) {
                for (const [key, tile] of tiles) list(tile, key);
                continue;
            }
            for (let row = top; row <= bottom; row += 1) {
                for (let column = left; column <= right; column += 1) {
                    const key = row * TILES_ACROSS + column;
                    const tile = tiles.get(key);
                    if (tile) list(tile, key);
                }
            }
        }
        return found;
    }

    // Lists the record of this id at its new rectangles in place of all its old ones, either of them none.
    public set(id: string, old: readonly Rect[] | undefined, next: readonly Rect[] | undefined): void {
        for (const rect of old ?? []) this.list(id, rect, false);
        for (const rect of next ?? []) this.list(id, rect, true);
    }

    private list(id: string, rect: Rect, add: boolean): void {
        const [top, left, bottom, right] = rect;
        const rowShift = Math.max(MIN_ROW_SHIFT, 32 - Math.clz32(bottom - top));
        const columnShift = Math.max(MIN_COLUMN_SHIFT, 32 - Math.clz32(right - left));
        const size = (rowShift << 4) | columnShift;
        const tiles = this.sizes.get(size) ?? new Map<number, Tile>();
        this.sizes.set(size, tiles);
        for (let row = top >> rowShift; row <= bottom >> rowShift; row += 1) {
            for (let column = left >> columnShift; column <= right >> columnShift; column += 1) {
                const key = row * TILES_ACROSS + column;
                const tile = tiles.get(key);
                const rects = tile?.get(id);
                if (!add) {
                    if (tile?.delete(id) && tile.size === 0) tiles.delete(key);
                } else if (rects) rects.push(rect);
                else if (tile) tile.set(id, [rect]);
                else tiles.set(key, new Map([[id, [rect]]]));
            }
        }
    }
}

// The columns the rectangles cover as rectangles side by side, in column order: each spans its columns from the first
// row any of the rectangles covers there to the last. A pass hands each column to the first rectangle in its order
// that covers it: `next` leads from a column towards the first one no earlier rectangle took, and each search points
// the columns it passed straight at what it found.
export function columnHull(rects: readonly Rect[]): Rect[] {
    if (rects.length === 0) return [];
    let low = GRID_COLUMNS;
    let high = -1;
    for (const [, left, , right] of rects) {
        low = Math.min(low, left);
        high = Math.max(high, right);
    }
    const width = high - low + 1;
    const tops = new Int32Array(width).fill(-1);
    const bottoms = new Int32Array(width);
    const next = new Int32Array(width + 1);
    // Each rectangle in its order writes its row into the columns no earlier one took, a stretch of them at a time.
    const pass = (order: Rect[], rows: Int32Array, row: (rect: Rect) => number) => {
        for (let at = 0; at <= width; at += 1) next[at] = at;
        const free = (from: number) => {
            let found = from;
            while (next[found] !== found) found = next[found];
            for (let at = from; at !== found; ) {
                const step = next[at];
                next[at] = found;
                at = step;
            }
            return found;
        };
        for (const rect of order) {
            const last = rect[3] - low;
            for (let at = free(rect[1] - low); at <= last; ) {
                let end = at;
                while (end <= last && next[end] === end) end += 1;
                rows.fill(row(rect), at, end);
                next.fill(end, at, end);
                at = free(end);
            }
        }
    };
    pass(
        [...rects].sort((a, b) => a[0] - b[0]),
        tops,
        ([top]) => top,
    );
    pass(
        [...rects].sort((a, b) => b[2] - a[2]),
        bottoms,
        ([, , bottom]) => bottom,
    );
    const hull: Rect[] = [];
    for (let at = 0, start = 0; at <= width; at += 1) {
        if (at < width && tops[at] === tops[start] && bottoms[at] === bottoms[start]) continue;
        if (tops[start] >= 0) hull.push([tops[start], low + start, bottoms[start], low + at - 1]);
        start = at;
    }
    return hull;
}
