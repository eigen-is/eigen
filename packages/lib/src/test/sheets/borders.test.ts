import { describe, expect, test } from 'bun:test';
import { cloneSides, mergedBorderSides, mergeEdgeSides } from '../../sheets/borders';

const SIDE = { style: 1, color: '#000' };
const RED = { style: 8, color: '#f00' };

describe('mergedBorderSides', () => {
    test('non-merge cells pass through untouched', () => {
        const borderInfo = { '0_0': { l: SIDE }, '5_5': { b: SIDE } };
        expect(mergedBorderSides(borderInfo, undefined)).toEqual(borderInfo);
    });

    test('folds a border-outside box around A1:C3 onto the master', () => {
        const merge = { '0_0': { r: 0, c: 0, rs: 3, cs: 3 } };
        const borderInfo = {
            '0_0': { t: SIDE, l: SIDE },
            '0_2': { t: SIDE, r: RED },
            '2_0': { b: SIDE, l: SIDE },
            '2_2': { b: RED, r: RED },
        };
        expect(mergedBorderSides(borderInfo, merge)).toEqual({ '0_0': { t: SIDE, l: SIDE, r: RED, b: RED } });
    });

    test('drops interior sides and a non-master diagonal, deleting a master left empty', () => {
        const merge = { '0_0': { r: 0, c: 0, rs: 2, cs: 2 } };
        const borderInfo = { '0_1': { l: SIDE, b: SIDE, s: SIDE }, '1_0': { t: SIDE, r: SIDE } };
        expect(mergedBorderSides(borderInfo, merge)).toEqual({});
    });

    test('keeps the master diagonal', () => {
        const merge = { '1_1': { r: 1, c: 1, rs: 1, cs: 2 } };
        expect(mergedBorderSides({ '1_1': { s: SIDE } }, merge)).toEqual({ '1_1': { s: SIDE } });
    });

    test('a range visits only its cells, plus every constituent of a merge crossing it', () => {
        const merge = { '2_2': { r: 2, c: 2, rs: 2, cs: 2 } };
        const borderInfo = { '0_0': { l: SIDE }, '9_9': { l: SIDE }, '3_3': { r: RED, b: RED } };
        expect(mergedBorderSides(borderInfo, merge, [0, 2, 0, 2])).toEqual({
            '0_0': { l: SIDE },
            '2_2': { r: RED, b: RED },
        });
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
