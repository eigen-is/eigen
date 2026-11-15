// The tests a sheet asks of its rectangles, such as whether two meet, whether one lies inside another and whether any
// two of a list share a cell. The workbook asks them of merges, filters and the blocks an op names, and the op
// validators of a batch's runs and a sheet's merges, so both read one rule.

import type { Rect } from './ops';
import type { SingleRange } from './types';

export function meets(a: Rect, b: Rect): boolean {
    return a[0] <= b[2] && b[0] <= a[2] && a[1] <= b[3] && b[1] <= a[3];
}

export function within(inner: Rect, outer: Rect): boolean {
    return inner[0] >= outer[0] && inner[1] >= outer[1] && inner[2] <= outer[2] && inner[3] <= outer[3];
}

export function covers({ row, column }: SingleRange, r: number, c: number): boolean {
    return r >= row[0] && r <= row[1] && c >= column[0] && c <= column[1];
}

export function sameRect(a: Rect, b: Rect): boolean {
    return a[0] === b[0] && a[1] === b[1] && a[2] === b[2] && a[3] === b[3];
}

// Whether no two rectangles share a cell. A sweep across the columns counts how many rectangles cover each row, in a
// tree over the rows where rectangles start and end, so the check is n log n.
export function disjoint(rects: readonly Rect[]): boolean {
    if (rects.length < 2) return true;
    const edges = [...new Set(rects.flatMap(([top, , bottom]) => [top, bottom + 1]))].sort((a, b) => a - b);
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
    // An event is a rectangle entering at its left column or leaving after its right one; leaving sorts first.
    const at = (event: number) =>
        event < rects.length ? rects[event][1] * 2 + 1 : (rects[event - rects.length][3] + 1) * 2;
    const events = Array.from({ length: rects.length * 2 }, (_, event) => event).sort((a, b) => at(a) - at(b));
    const covered = new Coverage(edges.length - 1);
    for (const event of events) {
        const entering = event < rects.length;
        const [top, , bottom] = rects[entering ? event : event - rects.length];
        const from = slot(top);
        const to = slot(bottom + 1);
        if (entering && covered.most(from, to) > 0) return false;
        covered.add(from, to, entering ? 1 : -1);
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
