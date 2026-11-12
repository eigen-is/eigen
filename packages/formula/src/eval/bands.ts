// Lining up the arrays of one operation along one axis. An array stores one row for a run of equal written rows,
// and two arrays seldom cut their runs at the same places, so the result runs wherever one of them does. This is
// the only code that pairs the elements of two arrays, so they are always paired by where they were written.

import type { ArrayValue } from '../values/value';

export type Axis = {
    // The runs of the result, and one past the last written row or column of each: null when each run is one.
    readonly count: number;
    readonly ends: Int32Array | null;
    // Per array, the stored row or column each run reads, and -1 past the end of an array shorter than the result.
    // Null for an array whose own runs are the result's.
    readonly from: readonly (Int32Array | null)[];
};

// The rows of an operation over these arrays that is `size` rows long, or its columns. An array of one row is
// read by every run, and a shorter one of more rows ends where it ends.
export function align(arrays: readonly ArrayValue[], size: number, rows: boolean): Axis {
    const first = rows ? arrays[0].rowEnds : arrays[0].columnEnds;
    let alike = true;
    for (const array of arrays) {
        const ends = rows ? array.rowEnds : array.columnEnds;
        alike &&= (rows ? array.rows : array.columns) === size && ends?.length === first?.length;
        for (let i = 0; alike && ends !== first && ends !== null && first !== null && i < ends.length; i += 1) {
            alike = ends[i] === first[i];
        }
    }
    if (alike) return { count: rows ? arrays[0].height : arrays[0].width, ends: first, from: arrays.map(() => null) };
    const lengths = arrays.map((array) => (rows ? array.rows : array.columns));
    const stored = arrays.map((array) => (rows ? array.height : array.width));
    const own = arrays.map((array) => (rows ? array.rowEnds : array.columnEnds));
    let bound = 0;
    for (let k = 0; k < arrays.length; k += 1) bound += lengths[k] === 1 ? 0 : stored[k] + 1;
    bound = Math.min(bound, size);
    const merged = new Int32Array(bound);
    const from = arrays.map(() => new Int32Array(bound));
    // Per array, the stored row its run in progress is, and where that run ends.
    const run = arrays.map(() => 0);
    const stop = arrays.map((_, k) => (lengths[k] === 1 ? size : (own[k]?.[0] ?? 1)));
    let count = 0;
    for (let done = 0; done < size; count += 1) {
        done = size;
        for (let k = 0; k < arrays.length; k += 1) {
            from[k][count] = run[k] < stored[k] ? run[k] : -1;
            if (stop[k] < done) done = stop[k];
        }
        merged[count] = done;
        for (let k = 0; k < arrays.length; k += 1) {
            if (stop[k] !== done || done === size) continue;
            run[k] += 1;
            stop[k] = run[k] < stored[k] ? (own[k]?.[run[k]] ?? run[k] + 1) : size;
        }
    }
    // An array that already runs as the result does lends its ends, so the next operation on the result finds
    // the two alike without comparing them.
    const whole = arrays.findIndex((_, k) => lengths[k] === size && stored[k] === count);
    return {
        count,
        ends: whole >= 0 ? own[whole] : count === size ? null : merged.subarray(0, count),
        from: from.map((map, k) => (lengths[k] === size && stored[k] === count ? null : map.subarray(0, count))),
    };
}

// The same axis with every run cut into single rows or columns, for an operation that must make each element.
export function apart(axis: Axis, size: number): Axis {
    const from = axis.from.map((map) => {
        const each = new Int32Array(size);
        for (let at = 0, run = 0; at < size; at += 1) {
            if (axis.ends === null) run = at;
            else if (at === axis.ends[run]) run += 1;
            each[at] = map === null ? run : map[run];
        }
        return each;
    });
    return { count: size, ends: null, from };
}
