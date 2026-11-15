// Where the merges of one sheet lie, so a read finds the merge at a cell or the merges in a rectangle without a walk
// of them all. A merge is listed in bands of rows of its own size, the smallest power of two rows that holds its
// height, so it lies in two bands at most however tall it is, and its width costs nothing; a read looks, per band size
// in use, at the bands on its rows only. The sheet's records keep it in step with every merge they write, by id, so it
// holds while a line edit or a move rewrites the merges one by one.

import type { Rect } from '@workspace/lib/sheets/ops';
import { meets } from '@workspace/lib/sheets/rect';

// A band holds two to this power of rows at least.
const MIN_BAND_SHIFT = 6;

export class MergeIndex {
    // By band size, then by band of rows, the merges with a row in the band.
    private readonly bands = new Map<number, Map<number, Map<string, Rect>>>();

    public at(row: number, column: number): Rect | undefined {
        for (const [shift, bands] of this.bands) {
            for (const rect of bands.get(row >> shift)?.values() ?? []) {
                if (row >= rect[0] && row <= rect[2] && column >= rect[1] && column <= rect[3]) return rect;
            }
        }
        return undefined;
    }

    // The merges with a cell in the rectangle, by id.
    public meeting(rect: Rect): Map<string, Rect> {
        const found = new Map<string, Rect>();
        for (const [shift, bands] of this.bands) {
            for (let band = rect[0] >> shift; band <= rect[2] >> shift; band += 1) {
                for (const [id, merge] of bands.get(band) ?? []) if (meets(merge, rect)) found.set(id, merge);
            }
        }
        return found;
    }

    // Lists the merge of this id at its new rectangle in place of its old one, either of them none.
    public set(id: string, old: Rect | undefined, next: Rect | undefined): void {
        if (old) this.list(id, old, false);
        if (next) this.list(id, next, true);
    }

    private list(id: string, rect: Rect, add: boolean): void {
        const [top, , bottom] = rect;
        const shift = Math.max(MIN_BAND_SHIFT, 32 - Math.clz32(bottom - top));
        const bands = this.bands.get(shift) ?? new Map<number, Map<string, Rect>>();
        for (let band = top >> shift; band <= bottom >> shift; band += 1) {
            const merges = bands.get(band) ?? new Map<string, Rect>();
            if (add) bands.set(band, merges.set(id, rect));
            else if (merges.delete(id) && merges.size === 0) bands.delete(band);
        }
        if (bands.size > 0) this.bands.set(shift, bands);
        else this.bands.delete(shift);
    }
}
