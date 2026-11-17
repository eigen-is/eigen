// Where rectangles lie on a sheet, such as the merges of a record type, so a read finds the ones at a cell or on a
// screen without a walk of them all. A rectangle is listed in tiles of its own size, the smallest power of two rows
// and of two columns that hold its height and its width, so it lies in four tiles at most, and a read looks, per tile
// size in use, at the tiles it covers only. The records keep one by id. An op's read and a sheet's walk sweep their
// rectangles instead, a stretch of columns at a time, down which they go from one to the next.

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

// One sweep left to right over the columns that rectangles sharing no cell cover. At each stretch of columns `live`
// holds the places of the rectangles over it sorted by top, changed in place, so it serves one pass at a time.
export class ColumnSweep {
    public readonly live: number[] = [];
    // The columns where a rectangle starts or one ends, and the places by the column each starts at and ends past.
    private readonly edges: number[] = [];
    private readonly starts: number[] = [];
    private readonly ends: number[] = [];

    public constructor(public readonly rects: readonly Rect[]) {
        if (rects.length === 0) return;
        const edges = rects.flatMap(([, left, , right]) => [left, right + 1]).sort((a, b) => a - b);
        this.edges = edges.filter((edge, at) => edge !== edges[at + 1]);
        // Ties go by top, so the rectangles that start or end at one column join and leave `live` at its end.
        const places = [...rects.keys()];
        this.starts = places.toSorted((a, b) => rects[a][1] - rects[b][1] || rects[a][0] - rects[b][0]);
        this.ends = places.sort((a, b) => rects[a][3] - rects[b][3] || rects[b][0] - rects[a][0]);
    }

    // Tells `visit` the first and last column of each stretch, in column order, while `live` holds its rectangles.
    public pass(visit: (left: number, right: number) => void): void {
        const { rects, live, edges, starts, ends } = this;
        // A pass before this one left the rectangles of its last stretch, which all end at the last edge.
        if (live.length > 0) live.length = 0;
        let started = 0;
        let ended = 0;
        for (let at = 0; at < edges.length - 1; at += 1) {
            const left = edges[at];
            for (; ended < ends.length && rects[ends[ended]][3] < left; ended += 1) {
                live.splice(this.after(rects[ends[ended]][0]) - 1, 1);
            }
            for (; started < starts.length && rects[starts[started]][1] === left; started += 1) {
                live.splice(this.after(rects[starts[started]][0]), 0, starts[started]);
            }
            if (live.length > 0) visit(left, edges[at + 1] - 1);
        }
    }

    // The place in `live` of the first rectangle whose top is below the row, or their count. The one before it holds
    // the row if its bottom reaches it.
    public after(row: number): number {
        const { rects, live } = this;
        let low = 0;
        let high = live.length;
        while (low < high) {
            const middle = (low + high) >> 1;
            if (rects[live[middle]][0] <= row) low = middle + 1;
            else high = middle;
        }
        return low;
    }
}
