import { describe, expect, test } from 'bun:test';
import { rangeWithout } from '../../engine/conditional-format';
import type { SingleRange } from '../../engine/types';

// The area is rows 2 to 5 of columns 2 to 5. Each case picks one way a range can lie against it.
const AREA: SingleRange = { row: [2, 5], column: [2, 5] };

describe('rangeWithout — CF range fully inside operate range', () => {
    test('identical range — nothing is left', () => {
        const cf: SingleRange = { row: [2, 5], column: [2, 5] };
        expect(rangeWithout(cf, AREA)).toEqual([]);
    });

    test('strictly inside (center) — nothing is left', () => {
        const cf: SingleRange = { row: [3, 4], column: [3, 4] };
        expect(rangeWithout(cf, AREA)).toEqual([]);
    });
});

describe('rangeWithout — row-band overlaps (cols inside)', () => {
    test('upper: CF top inside, bottom sticks out below', () => {
        const cf: SingleRange = { row: [3, 7], column: [2, 5] };
        expect(rangeWithout(cf, AREA)).toEqual([{ row: [6, 7], column: [2, 5] }]);
    });

    test('lower: CF bottom inside, top sticks out above', () => {
        const cf: SingleRange = { row: [0, 4], column: [2, 5] };
        expect(rangeWithout(cf, AREA)).toEqual([{ row: [0, 1], column: [2, 5] }]);
    });

    test('middle: CF taller, sticks out above and below', () => {
        const cf: SingleRange = { row: [0, 7], column: [2, 5] };
        expect(rangeWithout(cf, AREA)).toEqual([
            { row: [0, 1], column: [2, 5] },
            { row: [6, 7], column: [2, 5] },
        ]);
    });
});

describe('rangeWithout — column-band overlaps (rows inside)', () => {
    test('left: CF left inside, right sticks out', () => {
        const cf: SingleRange = { row: [2, 5], column: [3, 7] };
        expect(rangeWithout(cf, AREA)).toEqual([{ row: [2, 5], column: [6, 7] }]);
    });

    test('right: CF right inside, left sticks out', () => {
        const cf: SingleRange = { row: [2, 5], column: [0, 4] };
        expect(rangeWithout(cf, AREA)).toEqual([{ row: [2, 5], column: [0, 1] }]);
    });

    test('middle: CF wider, sticks out left and right', () => {
        const cf: SingleRange = { row: [2, 5], column: [0, 7] };
        expect(rangeWithout(cf, AREA)).toEqual([
            { row: [2, 5], column: [0, 1] },
            { row: [2, 5], column: [6, 7] },
        ]);
    });
});

describe('rangeWithout — corner overlaps', () => {
    test('top-left corner (CF extends down and right)', () => {
        const cf: SingleRange = { row: [3, 7], column: [3, 7] };
        expect(rangeWithout(cf, AREA)).toEqual([
            { row: [3, 5], column: [6, 7] },
            { row: [6, 7], column: [3, 7] },
        ]);
    });

    test('top-right corner (CF extends down and left)', () => {
        const cf: SingleRange = { row: [3, 7], column: [0, 4] };
        expect(rangeWithout(cf, AREA)).toEqual([
            { row: [3, 5], column: [0, 1] },
            { row: [6, 7], column: [0, 4] },
        ]);
    });

    test('bottom-left corner (CF extends up and right)', () => {
        const cf: SingleRange = { row: [0, 4], column: [3, 7] };
        expect(rangeWithout(cf, AREA)).toEqual([
            { row: [0, 1], column: [3, 7] },
            { row: [2, 4], column: [6, 7] },
        ]);
    });

    test('bottom-right corner (CF extends up and left)', () => {
        const cf: SingleRange = { row: [0, 4], column: [0, 4] };
        expect(rangeWithout(cf, AREA)).toEqual([
            { row: [0, 1], column: [0, 4] },
            { row: [2, 4], column: [0, 1] },
        ]);
    });
});

describe('rangeWithout — edge-straddling overlaps (CF spans one axis, straddles one edge on the other)', () => {
    test('left-middle: CF spans rows, straddles the left edge (extends right)', () => {
        const cf: SingleRange = { row: [0, 7], column: [3, 7] };
        expect(rangeWithout(cf, AREA)).toEqual([
            { row: [0, 1], column: [3, 7] },
            { row: [2, 5], column: [6, 7] },
            { row: [6, 7], column: [3, 7] },
        ]);
    });

    test('right-middle: CF spans rows, straddles the right edge (extends left)', () => {
        const cf: SingleRange = { row: [0, 7], column: [0, 4] };
        expect(rangeWithout(cf, AREA)).toEqual([
            { row: [0, 1], column: [0, 4] },
            { row: [2, 5], column: [0, 1] },
            { row: [6, 7], column: [0, 4] },
        ]);
    });

    test('top-middle: CF spans cols, straddles the top edge (extends down)', () => {
        const cf: SingleRange = { row: [3, 7], column: [0, 7] };
        expect(rangeWithout(cf, AREA)).toEqual([
            { row: [3, 5], column: [0, 1] },
            { row: [3, 5], column: [6, 7] },
            { row: [6, 7], column: [0, 7] },
        ]);
    });

    test('bottom-middle: CF spans cols, straddles the bottom edge (extends up)', () => {
        const cf: SingleRange = { row: [0, 4], column: [0, 7] };
        expect(rangeWithout(cf, AREA)).toEqual([
            { row: [0, 1], column: [0, 7] },
            { row: [2, 4], column: [0, 1] },
            { row: [2, 4], column: [6, 7] },
        ]);
    });
});

describe('rangeWithout — operate range fully inside CF range (center)', () => {
    test('CF surrounds operate on all four sides — rest = the 4-piece ring, operate = shifted core', () => {
        const cf: SingleRange = { row: [0, 7], column: [0, 7] };
        expect(rangeWithout(cf, AREA)).toEqual([
            { row: [0, 1], column: [0, 7] },
            { row: [2, 5], column: [0, 1] },
            { row: [2, 5], column: [6, 7] },
            { row: [6, 7], column: [0, 7] },
        ]);
    });
});

describe('rangeWithout — no overlap (disjoint)', () => {
    test('CF fully below-right of operate — the range is left whole', () => {
        const cf: SingleRange = { row: [10, 12], column: [10, 12] };
        expect(rangeWithout(cf, AREA)).toEqual([{ row: [10, 12], column: [10, 12] }]);
    });

    test('CF row-aligned but column-disjoint (to the right) — still the disjoint branch', () => {
        const cf: SingleRange = { row: [2, 5], column: [10, 12] };
        expect(rangeWithout(cf, AREA)).toEqual([{ row: [2, 5], column: [10, 12] }]);
    });
});
