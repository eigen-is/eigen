import { describe, expect, test } from 'bun:test';
import type { CfSplitRangeType } from '../../engine/conditional-format';
import { cfSplitRange } from '../../engine/conditional-format';
import type { SingleRange } from '../../engine/types';

// Characterization tests for cfSplitRange (SHEETS-TODO.md E2).
//
// cfSplitRange(range1, range2, range3, type) splits a conditional-format apply
// range (range1) against an operate/selection range (range2) that is being
// cut/moved to a destination (range3). It distinguishes 16 geometric overlap
// relations plus a no-overlap fallback, and for each returns one of three
// slices selected by `type`:
//   - 'restPart'    : the portions of range1 that stay put (outside range2)
//   - 'operatePart' : the portion of range1 inside range2, shifted by range3−range2
//   - 'allPart'     : restPart ++ operatePart (all resulting pieces)
// Only range3.row[0]/column[0] are read — the shift is
//   offset_r = range3.row[0]    − range2.row[0]
//   offset_c = range3.column[0] − range2.column[0]
//
// Fixtures below fix the operate range at rows 2–5 × cols 2–5 and a destination
// that yields offset_r = 10, offset_c = 20 (distinct so a row/col offset swap
// would fail). Every expected literal is derived by reading the code path, then
// confirmed by `bun test`. range1 is chosen per case so the else-if chain lands
// on exactly the intended branch (verified: no earlier branch captures it).

const OPERATE: SingleRange = { row: [2, 5], column: [2, 5] };
// Only [0] of each axis matters; ends are padding. offset_r = 10, offset_c = 20.
const DEST: SingleRange = { row: [12, 15], column: [22, 25] };

function split(cf: SingleRange, type: CfSplitRangeType): SingleRange[] {
    return cfSplitRange(cf, OPERATE, DEST, type);
}

describe('engine/cfSplitRange — CF range fully inside operate range', () => {
    test('identical range — all/operate = shifted whole, rest = empty', () => {
        const cf: SingleRange = { row: [2, 5], column: [2, 5] };
        expect(split(cf, 'allPart')).toEqual([{ row: [12, 15], column: [22, 25] }]);
        expect(split(cf, 'operatePart')).toEqual([{ row: [12, 15], column: [22, 25] }]);
        expect(split(cf, 'restPart')).toEqual([]);
    });

    test('strictly inside (center) — all/operate = shifted whole, rest = empty', () => {
        const cf: SingleRange = { row: [3, 4], column: [3, 4] };
        expect(split(cf, 'allPart')).toEqual([{ row: [13, 14], column: [23, 24] }]);
        expect(split(cf, 'operatePart')).toEqual([{ row: [13, 14], column: [23, 24] }]);
        expect(split(cf, 'restPart')).toEqual([]);
    });
});

describe('engine/cfSplitRange — row-band overlaps (cols inside)', () => {
    test('upper: CF top inside, bottom sticks out below', () => {
        const cf: SingleRange = { row: [3, 7], column: [2, 5] };
        expect(split(cf, 'restPart')).toEqual([{ row: [6, 7], column: [2, 5] }]);
        expect(split(cf, 'operatePart')).toEqual([{ row: [13, 15], column: [22, 25] }]);
        expect(split(cf, 'allPart')).toEqual([
            { row: [6, 7], column: [2, 5] },
            { row: [13, 15], column: [22, 25] },
        ]);
    });

    test('lower: CF bottom inside, top sticks out above', () => {
        const cf: SingleRange = { row: [0, 4], column: [2, 5] };
        expect(split(cf, 'restPart')).toEqual([{ row: [0, 1], column: [2, 5] }]);
        expect(split(cf, 'operatePart')).toEqual([{ row: [12, 14], column: [22, 25] }]);
        expect(split(cf, 'allPart')).toEqual([
            { row: [0, 1], column: [2, 5] },
            { row: [12, 14], column: [22, 25] },
        ]);
    });

    test('middle: CF taller, sticks out above and below', () => {
        const cf: SingleRange = { row: [0, 7], column: [2, 5] };
        expect(split(cf, 'restPart')).toEqual([
            { row: [0, 1], column: [2, 5] },
            { row: [6, 7], column: [2, 5] },
        ]);
        expect(split(cf, 'operatePart')).toEqual([{ row: [12, 15], column: [22, 25] }]);
        expect(split(cf, 'allPart')).toEqual([
            { row: [0, 1], column: [2, 5] },
            { row: [6, 7], column: [2, 5] },
            { row: [12, 15], column: [22, 25] },
        ]);
    });
});

describe('engine/cfSplitRange — column-band overlaps (rows inside)', () => {
    test('left: CF left inside, right sticks out', () => {
        const cf: SingleRange = { row: [2, 5], column: [3, 7] };
        expect(split(cf, 'restPart')).toEqual([{ row: [2, 5], column: [6, 7] }]);
        expect(split(cf, 'operatePart')).toEqual([{ row: [12, 15], column: [23, 25] }]);
        expect(split(cf, 'allPart')).toEqual([
            { row: [2, 5], column: [6, 7] },
            { row: [12, 15], column: [23, 25] },
        ]);
    });

    test('right: CF right inside, left sticks out', () => {
        const cf: SingleRange = { row: [2, 5], column: [0, 4] };
        expect(split(cf, 'restPart')).toEqual([{ row: [2, 5], column: [0, 1] }]);
        expect(split(cf, 'operatePart')).toEqual([{ row: [12, 15], column: [22, 24] }]);
        expect(split(cf, 'allPart')).toEqual([
            { row: [2, 5], column: [0, 1] },
            { row: [12, 15], column: [22, 24] },
        ]);
    });

    test('middle: CF wider, sticks out left and right', () => {
        const cf: SingleRange = { row: [2, 5], column: [0, 7] };
        expect(split(cf, 'restPart')).toEqual([
            { row: [2, 5], column: [0, 1] },
            { row: [2, 5], column: [6, 7] },
        ]);
        expect(split(cf, 'operatePart')).toEqual([{ row: [12, 15], column: [22, 25] }]);
        expect(split(cf, 'allPart')).toEqual([
            { row: [2, 5], column: [0, 1] },
            { row: [2, 5], column: [6, 7] },
            { row: [12, 15], column: [22, 25] },
        ]);
    });
});

describe('engine/cfSplitRange — corner overlaps', () => {
    test('top-left corner (CF extends down and right)', () => {
        const cf: SingleRange = { row: [3, 7], column: [3, 7] };
        expect(split(cf, 'restPart')).toEqual([
            { row: [3, 5], column: [6, 7] },
            { row: [6, 7], column: [3, 7] },
        ]);
        expect(split(cf, 'operatePart')).toEqual([{ row: [13, 15], column: [23, 25] }]);
        expect(split(cf, 'allPart')).toEqual([
            { row: [3, 5], column: [6, 7] },
            { row: [6, 7], column: [3, 7] },
            { row: [13, 15], column: [23, 25] },
        ]);
    });

    test('top-right corner (CF extends down and left)', () => {
        const cf: SingleRange = { row: [3, 7], column: [0, 4] };
        expect(split(cf, 'restPart')).toEqual([
            { row: [3, 5], column: [0, 1] },
            { row: [6, 7], column: [0, 4] },
        ]);
        expect(split(cf, 'operatePart')).toEqual([{ row: [13, 15], column: [22, 24] }]);
        expect(split(cf, 'allPart')).toEqual([
            { row: [3, 5], column: [0, 1] },
            { row: [6, 7], column: [0, 4] },
            { row: [13, 15], column: [22, 24] },
        ]);
    });

    test('bottom-left corner (CF extends up and right)', () => {
        const cf: SingleRange = { row: [0, 4], column: [3, 7] };
        expect(split(cf, 'restPart')).toEqual([
            { row: [0, 1], column: [3, 7] },
            { row: [2, 4], column: [6, 7] },
        ]);
        expect(split(cf, 'operatePart')).toEqual([{ row: [12, 14], column: [23, 25] }]);
        expect(split(cf, 'allPart')).toEqual([
            { row: [0, 1], column: [3, 7] },
            { row: [2, 4], column: [6, 7] },
            { row: [12, 14], column: [23, 25] },
        ]);
    });

    test('bottom-right corner (CF extends up and left)', () => {
        const cf: SingleRange = { row: [0, 4], column: [0, 4] };
        expect(split(cf, 'restPart')).toEqual([
            { row: [0, 1], column: [0, 4] },
            { row: [2, 4], column: [0, 1] },
        ]);
        expect(split(cf, 'operatePart')).toEqual([{ row: [12, 14], column: [22, 24] }]);
        expect(split(cf, 'allPart')).toEqual([
            { row: [0, 1], column: [0, 4] },
            { row: [2, 4], column: [0, 1] },
            { row: [12, 14], column: [22, 24] },
        ]);
    });
});

describe('engine/cfSplitRange — edge-straddling overlaps (CF spans one axis, straddles one edge on the other)', () => {
    test('left-middle: CF spans rows, straddles the left edge (extends right)', () => {
        const cf: SingleRange = { row: [0, 7], column: [3, 7] };
        expect(split(cf, 'restPart')).toEqual([
            { row: [0, 1], column: [3, 7] },
            { row: [2, 5], column: [6, 7] },
            { row: [6, 7], column: [3, 7] },
        ]);
        expect(split(cf, 'operatePart')).toEqual([{ row: [12, 15], column: [23, 25] }]);
        expect(split(cf, 'allPart')).toEqual([
            { row: [0, 1], column: [3, 7] },
            { row: [2, 5], column: [6, 7] },
            { row: [6, 7], column: [3, 7] },
            { row: [12, 15], column: [23, 25] },
        ]);
    });

    test('right-middle: CF spans rows, straddles the right edge (extends left)', () => {
        const cf: SingleRange = { row: [0, 7], column: [0, 4] };
        expect(split(cf, 'restPart')).toEqual([
            { row: [0, 1], column: [0, 4] },
            { row: [2, 5], column: [0, 1] },
            { row: [6, 7], column: [0, 4] },
        ]);
        expect(split(cf, 'operatePart')).toEqual([{ row: [12, 15], column: [22, 24] }]);
        expect(split(cf, 'allPart')).toEqual([
            { row: [0, 1], column: [0, 4] },
            { row: [2, 5], column: [0, 1] },
            { row: [6, 7], column: [0, 4] },
            { row: [12, 15], column: [22, 24] },
        ]);
    });

    test('top-middle: CF spans cols, straddles the top edge (extends down)', () => {
        const cf: SingleRange = { row: [3, 7], column: [0, 7] };
        expect(split(cf, 'restPart')).toEqual([
            { row: [3, 5], column: [0, 1] },
            { row: [3, 5], column: [6, 7] },
            { row: [6, 7], column: [0, 7] },
        ]);
        expect(split(cf, 'operatePart')).toEqual([{ row: [13, 15], column: [22, 25] }]);
        expect(split(cf, 'allPart')).toEqual([
            { row: [3, 5], column: [0, 1] },
            { row: [3, 5], column: [6, 7] },
            { row: [6, 7], column: [0, 7] },
            { row: [13, 15], column: [22, 25] },
        ]);
    });

    test('bottom-middle: CF spans cols, straddles the bottom edge (extends up)', () => {
        const cf: SingleRange = { row: [0, 4], column: [0, 7] };
        expect(split(cf, 'restPart')).toEqual([
            { row: [0, 1], column: [0, 7] },
            { row: [2, 4], column: [0, 1] },
            { row: [2, 4], column: [6, 7] },
        ]);
        expect(split(cf, 'operatePart')).toEqual([{ row: [12, 14], column: [22, 25] }]);
        expect(split(cf, 'allPart')).toEqual([
            { row: [0, 1], column: [0, 7] },
            { row: [2, 4], column: [0, 1] },
            { row: [2, 4], column: [6, 7] },
            { row: [12, 14], column: [22, 25] },
        ]);
    });
});

describe('engine/cfSplitRange — operate range fully inside CF range (center)', () => {
    test('CF surrounds operate on all four sides — rest = the 4-piece ring, operate = shifted core', () => {
        const cf: SingleRange = { row: [0, 7], column: [0, 7] };
        expect(split(cf, 'restPart')).toEqual([
            { row: [0, 1], column: [0, 7] },
            { row: [2, 5], column: [0, 1] },
            { row: [2, 5], column: [6, 7] },
            { row: [6, 7], column: [0, 7] },
        ]);
        expect(split(cf, 'operatePart')).toEqual([{ row: [12, 15], column: [22, 25] }]);
        expect(split(cf, 'allPart')).toEqual([
            { row: [0, 1], column: [0, 7] },
            { row: [2, 5], column: [0, 1] },
            { row: [2, 5], column: [6, 7] },
            { row: [6, 7], column: [0, 7] },
            { row: [12, 15], column: [22, 25] },
        ]);
    });
});

describe('engine/cfSplitRange — no overlap (disjoint)', () => {
    test('CF fully below-right of operate — rest/all = CF unchanged, operate = empty', () => {
        const cf: SingleRange = { row: [10, 12], column: [10, 12] };
        expect(split(cf, 'restPart')).toEqual([{ row: [10, 12], column: [10, 12] }]);
        expect(split(cf, 'allPart')).toEqual([{ row: [10, 12], column: [10, 12] }]);
        expect(split(cf, 'operatePart')).toEqual([]);
    });

    test('CF row-aligned but column-disjoint (to the right) — still the disjoint branch', () => {
        const cf: SingleRange = { row: [2, 5], column: [10, 12] };
        expect(split(cf, 'restPart')).toEqual([{ row: [2, 5], column: [10, 12] }]);
        expect(split(cf, 'allPart')).toEqual([{ row: [2, 5], column: [10, 12] }]);
        expect(split(cf, 'operatePart')).toEqual([]);
    });
});

describe('engine/cfSplitRange — unrecognised type', () => {
    test('a type outside all/rest/operate throws (a caller typo must not silently drop CF ranges)', () => {
        const cf: SingleRange = { row: [2, 5], column: [2, 5] };
        // The param is compile-time narrowed to the three valid parts; untyped
        // state-layer callers can still pass a bad string, so the runtime guard
        // must throw rather than silently return [].
        const badType: string = 'nonsense';
        expect(() => split(cf, badType as CfSplitRangeType)).toThrow();
    });
});
