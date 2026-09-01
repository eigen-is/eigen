import { describe, expect, test } from 'bun:test';
import {
    BORDER_STYLES,
    borderInfoExtent,
    borderSidesToCss,
    cloneSides,
    mergedBorderSides,
    mergeEdgeSides,
    parseCellKey,
} from '../../sheets/borders';

const SIDE = { style: 1, color: '#000' };
const RED = { style: 8, color: '#f00' };

describe('mergedBorderSides', () => {
    test('non-merge cells pass through untouched', () => {
        const borderInfo = { '0_0': { l: SIDE }, '5_5': { b: SIDE } };
        expect(mergedBorderSides(borderInfo, undefined, [0, 5, 0, 5])).toEqual(borderInfo);
    });

    test('folds a border-outside box around A1:C3 onto the master', () => {
        const merge = { '0_0': { r: 0, c: 0, rs: 3, cs: 3 } };
        const borderInfo = {
            '0_0': { t: SIDE, l: SIDE },
            '0_2': { t: SIDE, r: RED },
            '2_0': { b: SIDE, l: SIDE },
            '2_2': { b: RED, r: RED },
        };
        expect(mergedBorderSides(borderInfo, merge, [0, 2, 0, 2])).toEqual({
            '0_0': { t: SIDE, l: SIDE, r: RED, b: RED },
        });
    });

    test('drops interior sides and a non-master diagonal, deleting a master left empty', () => {
        const merge = { '0_0': { r: 0, c: 0, rs: 2, cs: 2 } };
        const borderInfo = { '0_1': { l: SIDE, b: SIDE, s: SIDE }, '1_0': { t: SIDE, r: SIDE } };
        expect(mergedBorderSides(borderInfo, merge, [0, 1, 0, 1])).toEqual({});
    });

    test('keeps the master diagonal', () => {
        const merge = { '1_1': { r: 1, c: 1, rs: 1, cs: 2 } };
        expect(mergedBorderSides({ '1_1': { s: SIDE } }, merge, [1, 1, 1, 2])).toEqual({ '1_1': { s: SIDE } });
    });

    test('a crossing merge folds only its in-window constituents onto the master', () => {
        // A1:C3 merge, window A1:B2. The master top edge (0_0) and an in-window left edge (1_0)
        // fold onto the master; the far corner 2_2 is OUTSIDE the window, so it folds nothing.
        const merge = { '0_0': { r: 0, c: 0, rs: 3, cs: 3 } };
        const borderInfo = { '0_0': { t: SIDE }, '1_0': { l: SIDE }, '2_2': { b: RED, r: RED } };
        expect(mergedBorderSides(borderInfo, merge, [0, 1, 0, 1])).toEqual({
            '0_0': { t: SIDE, l: SIDE },
        });
    });

    test('empty borderInfo returns empty without expanding a window-crossing merge', () => {
        // A1:A1000000 crossing the range: with no borders there is nothing to fold, so the
        // merge must never be expanded. Any walk of its extent would show up as a slow test.
        const merge = { '0_0': { r: 0, c: 0, rs: 1_000_000, cs: 1 } };
        expect(mergedBorderSides({}, merge, [0, 0, 0, 0])).toEqual({});
    });

    test('a window-crossing huge merge with a border expands only the window', () => {
        // A1:A1000000 crossing the window [0,1,0,0]: the merge intersects, so it is expanded —
        // but only over its two in-window cells, never its million-row extent (that would hang).
        // The master top edge folds; a border far down (999999_0) is off-window and folds nothing.
        const merge = { '0_0': { r: 0, c: 0, rs: 1_000_000, cs: 1 } };
        const borderInfo = { '0_0': { t: SIDE }, '999999_0': { b: RED } };
        expect(mergedBorderSides(borderInfo, merge, [0, 1, 0, 0])).toEqual({ '0_0': { t: SIDE } });
    });

    test('a huge merge outside the range contributes nothing and is not expanded', () => {
        // A1:A1000000 — a rangeless call expanded it into a million-entry map; the range must skip it.
        const merge = { '0_0': { r: 0, c: 0, rs: 1_000_000, cs: 1 } };
        const borderInfo = { '5_5': { l: SIDE } };
        expect(mergedBorderSides(borderInfo, merge, [5, 5, 5, 5])).toEqual({ '5_5': { l: SIDE } });
    });
});

describe('parseCellKey', () => {
    test('splits "r_c" into numbers', () => {
        expect(parseCellKey('12_3')).toEqual([12, 3]);
        expect(parseCellKey('0_0')).toEqual([0, 0]);
    });
});

describe('cloneSides', () => {
    test('copies each present side into a fresh object', () => {
        const sides = { l: SIDE, s: RED };
        const copy = cloneSides(sides);
        expect(copy).toEqual(sides);
        expect(copy.l).not.toBe(sides.l);
        expect('t' in copy).toBe(false);
    });
});

describe('mergeEdgeSides', () => {
    const mc = { r: 1, c: 1, rs: 2, cs: 2 };
    const all = { l: SIDE, r: SIDE, t: SIDE, b: SIDE, s: RED };

    test('keeps only the sides on the merge outer edge; the diagonal only on the master', () => {
        expect(mergeEdgeSides(all, mc, 1, 1)).toEqual({ l: SIDE, t: SIDE, s: RED });
        expect(mergeEdgeSides(all, mc, 2, 2)).toEqual({ r: SIDE, b: SIDE });
    });

    test('returns undefined when nothing survives', () => {
        expect(mergeEdgeSides({ l: SIDE, t: SIDE, s: RED }, mc, 2, 2)).toBeUndefined();
    });
});

describe('BORDER_STYLES canvas paint', () => {
    // Pins the exact dash/lineWidth the old re-capitalize cascade produced, per ordinal 1-13, so
    // the canvas stays pixel-identical. Double (7) and slantDashDot (12) paint at lineWidth 1 by
    // design (screen-vs-print divergence), even though their css is 3px/2px.
    test('dash + lineWidth per ordinal', () => {
        const paint = Object.fromEntries(
            Object.entries(BORDER_STYLES).map(([ord, s]) => [ord, { dash: s.dash, lineWidth: s.lineWidth }]),
        );
        expect(paint).toEqual({
            1: { dash: [0], lineWidth: 1 },
            2: { dash: [1, 2], lineWidth: 1 },
            3: { dash: [2], lineWidth: 1 },
            4: { dash: [3], lineWidth: 1 },
            5: { dash: [2, 5, 2], lineWidth: 1 },
            6: { dash: [2, 2, 5, 2, 2], lineWidth: 1 },
            7: { dash: [0], lineWidth: 1 },
            8: { dash: [0], lineWidth: 2 },
            9: { dash: [3], lineWidth: 2 },
            10: { dash: [2, 5, 2], lineWidth: 2 },
            11: { dash: [2, 2, 5, 2, 2], lineWidth: 2 },
            12: { dash: [2, 5, 2], lineWidth: 1 },
            13: { dash: [0], lineWidth: 3 },
        });
    });
});

describe('borderSidesToCss', () => {
    test('emits a declaration per present side, skipping the diagonal, no trailing ;', () => {
        expect(borderSidesToCss({ l: { style: 1, color: '#000' }, b: { style: 8, color: '#f00' }, s: SIDE })).toEqual([
            'border-left:1px solid #000',
            'border-bottom:2px solid #f00',
        ]);
    });

    test('mapColor rewrites each color (the BE export passes its escaper)', () => {
        expect(borderSidesToCss({ t: { style: 1, color: 'x' } }, (c) => `[${c}]`)).toEqual([
            'border-top:1px solid [x]',
        ]);
    });
});

describe('borderInfoExtent', () => {
    test('bounds the raw keys', () => {
        expect(borderInfoExtent({ '2_3': { l: SIDE }, '5_1': { b: SIDE } })).toEqual({
            minRow: 2,
            minCol: 1,
            maxRow: 5,
            maxCol: 3,
        });
    });

    test('empty map is an inverted box that merges as a no-op', () => {
        expect(borderInfoExtent({})).toEqual({
            minRow: Number.MAX_SAFE_INTEGER,
            minCol: Number.MAX_SAFE_INTEGER,
            maxRow: -1,
            maxCol: -1,
        });
    });
});
