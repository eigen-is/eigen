// The whole grid, and the tests a sheet asks of its rectangles, such as whether two meet, whether one lies inside
// another and whether two of a list, or of two lists, share a cell. The workbook asks them of merges, rule ranges and
// the blocks an op names, and the op validators of a batch's runs and a sheet's merges, so both read one rule.

import { GRID_COLUMNS, GRID_ROWS } from '@workspace/formula/text';
import type { Rect } from './ops';

// Up to this many rectangles on one side, testing pair by pair is cheaper than a sweep.
const PAIRWISE_MOST = 32;

export const WHOLE_GRID: Rect = [0, 0, GRID_ROWS - 1, GRID_COLUMNS - 1];

export function meets(a: Rect, b: Rect): boolean {
    return a[0] <= b[2] && b[0] <= a[2] && a[1] <= b[3] && b[1] <= a[3];
}

export function within(inner: Rect, outer: Rect): boolean {
    return inner[0] >= outer[0] && inner[1] >= outer[1] && inner[2] <= outer[2] && inner[3] <= outer[3];
}

export function covers(rect: Rect, row: number, column: number): boolean {
    return row >= rect[0] && row <= rect[2] && column >= rect[1] && column <= rect[3];
}

export function sameRect(a: Rect, b: Rect): boolean {
    return a[0] === b[0] && a[1] === b[1] && a[2] === b[2] && a[3] === b[3];
}

// The cells two rectangles share, or null when they share none.
export function intersect(a: Rect, b: Rect): Rect | null {
    const both: Rect = [Math.max(a[0], b[0]), Math.max(a[1], b[1]), Math.min(a[2], b[2]), Math.min(a[3], b[3])];
    return both[0] <= both[2] && both[1] <= both[3] ? both : null;
}

// The cells of `target` that `block` does not hold, as at most four rectangles: the rows above and below the block,
// then beside it on its rows.
export function outsideOf(target: Rect, block: Rect): Rect[] {
    const [top, left, bottom, right] = target;
    if (top > block[2] || bottom < block[0] || left > block[3] || right < block[1]) return [target];
    const rects: Rect[] = [];
    if (top < block[0]) rects.push([top, left, block[0] - 1, right]);
    if (bottom > block[2]) rects.push([block[2] + 1, left, bottom, right]);
    const rows: [number, number] = [Math.max(top, block[0]), Math.min(bottom, block[2])];
    if (left < block[1]) rects.push([rows[0], left, rows[1], block[1] - 1]);
    if (right > block[3]) rects.push([rows[0], block[3] + 1, rows[1], right]);
    return rects;
}

// Whether no two rectangles share a cell.
export function disjoint(rects: readonly Rect[]): boolean {
    return rects.length < 2 || sweep(rects, rects.length);
}

// Whether no rectangle of one list shares a cell with one of the other.
export function apart(a: readonly Rect[], b: readonly Rect[]): boolean {
    if (Math.min(a.length, b.length) <= PAIRWISE_MOST) return !a.some((x) => b.some((y) => meets(x, y)));
    return sweep([...a, ...b], a.length);
}

// A sweep across the columns counts how many rectangles cover each row, in a tree over the rows where rectangles start
// and end, so the check is n log n. Those before `split` meet those from it on, or with none after it, each other.
function sweep(rects: readonly Rect[], split: number): boolean {
    const edges = Float64Array.from(new Set(rects.flatMap(([top, , bottom]) => [top, bottom + 1]))).sort();
    const slot = (row: number) => {
        let low = 0;
        let high = edges.length - 1;
        while (low < high) {
            const middle = (low + high) >> 1;
            if (edges[middle] < row) low = middle + 1;
            else high = middle;
        }
        return low;
    };
    // An event is a rectangle entering at its left column or leaving after its right one, leaving first, its number
    // packed below its column so that a numeric sort orders them.
    const count = rects.length * 2;
    const events = new Float64Array(count);
    for (const [index, [, left, , right]] of rects.entries()) {
        events[index] = (left * 2 + 1) * count + index;
        events[index + rects.length] = (right + 1) * 2 * count + index + rects.length;
    }
    events.sort();
    const sides = [new Coverage(edges.length - 1), new Coverage(edges.length - 1)];
    const one = split === rects.length;
    for (const key of events) {
        const event = key % count;
        const entering = event < rects.length;
        const index = entering ? event : event - rects.length;
        const [top, , bottom] = rects[index];
        const from = slot(top);
        const to = slot(bottom + 1);
        const side = index < split ? 0 : 1;
        if (entering && sides[one ? 0 : 1 - side].most(from, to) > 0) return false;
        sides[side].add(from, to, entering ? 1 : -1);
    }
    return true;
}

// How many rectangles cover each slot, in a segment tree: a node holds the count added over its whole span and the most
// any slot under it is covered.
class Coverage {
    private readonly added: Int32Array;
    private readonly peak: Int32Array;

    public constructor(private readonly size: number) {
        this.added = new Int32Array(4 * size);
        this.peak = new Int32Array(4 * size);
    }

    public add(from: number, to: number, delta: number, node = 1, low = 0, high = this.size): void {
        if (to <= low || high <= from) return;
        if (from <= low && high <= to) {
            this.added[node] += delta;
            this.peak[node] += delta;
            return;
        }
        const middle = (low + high) >> 1;
        this.add(from, to, delta, 2 * node, low, middle);
        this.add(from, to, delta, 2 * node + 1, middle, high);
        this.peak[node] = this.added[node] + Math.max(this.peak[2 * node], this.peak[2 * node + 1]);
    }

    public most(from: number, to: number, node = 1, low = 0, high = this.size): number {
        if (to <= low || high <= from) return 0;
        if (from <= low && high <= to) return this.peak[node];
        const middle = (low + high) >> 1;
        const below = Math.max(
            this.most(from, to, 2 * node, low, middle),
            this.most(from, to, 2 * node + 1, middle, high),
        );
        return this.added[node] + below;
    }
}
