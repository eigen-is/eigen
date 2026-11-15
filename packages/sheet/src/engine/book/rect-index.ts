// Where the rectangles of one record type lie on a sheet, such as its merges or the ranges of its rules, so a read
// finds the ones at a cell or on a screen without a walk of them all. A rectangle is listed in tiles of its own size,
// the smallest power of two rows and of two columns that hold its height and its width, so it lies in four tiles at
// most whatever its area, and a read looks, per tile size in use, at the tiles it covers only. The sheet's records
// keep it in step with every record they write, by id.

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
        if (tiles.size > 0) this.sizes.set(size, tiles);
        else this.sizes.delete(size);
    }
}
