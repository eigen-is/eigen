import { describe, expect, test } from 'bun:test';
import type { CellAttrs } from '@workspace/lib/sheets/ops';
import { LOOK_KEYS } from '@workspace/lib/sheets/ops';
import { Bands } from '../../../engine/book/bands';
import { LookTable } from '../../../engine/book/look-table';

// Every look key once, with a value of its type.
const FULL: Required<CellAttrs> = {
    bl: 1,
    it: 1,
    ff: 'Inter',
    fs: 11,
    fc: '#112233',
    cl: 1,
    un: 1,
    fa: '0.00',
    ht: 1,
    vt: 2,
    tb: '2',
    bg: '#ffeeaa',
    rt: 'vertical',
    bdt: { style: 1, color: '#000000' },
    bdb: { style: 2, color: '#111111' },
    bdl: { style: 3, color: '#222222' },
    bdr: { style: 4, color: '#333333' },
    bdd: { style: 5, color: '#444444' },
};

describe('engine/book/look-table — LookTable', () => {
    test('the plain look is id 0, however it is said', () => {
        const looks = new LookTable();
        expect(looks.size).toBe(1);
        expect(looks.intern({})).toBe(0);
        expect(looks.intern({ bl: undefined, bdt: undefined })).toBe(0);
        expect(looks.look(0)).toEqual({});
        expect(looks.size).toBe(1);
    });

    test('equal looks get one id whatever the order of their keys', () => {
        const looks = new LookTable();
        const id = looks.intern({ bl: 1, bg: '#fff', fa: '0%' });
        expect(id).toBe(1);
        expect(looks.intern({ fa: '0%', bg: '#fff', bl: 1 })).toBe(id);
        expect(looks.intern({ fa: '0%', bg: '#fff', bl: 1, it: undefined })).toBe(id);
        expect(looks.size).toBe(2);
    });

    test('a key given as undefined is not in the look it keeps', () => {
        const looks = new LookTable();
        const id = looks.intern({ fa: '0%', it: undefined, bl: 1 });
        expect(Object.keys(looks.look(id))).toEqual(['bl', 'fa']);
    });

    test('the look it keeps has its keys in LOOK_KEYS order', () => {
        const looks = new LookTable();
        const backwards: CellAttrs = {};
        for (const key of LOOK_KEYS.toReversed()) Object.assign(backwards, { [key]: FULL[key] });
        const id = looks.intern(backwards);
        expect(Object.keys(looks.look(id))).toEqual([...LOOK_KEYS]);
        expect(looks.look(id)).toEqual(FULL);
        expect(looks.intern(FULL)).toBe(id);
    });

    test('a border side is its style and its color, in that order, and nothing else', () => {
        const looks = new LookTable();
        const id = looks.intern({ bdt: { style: 1, color: '#000' } });
        expect(looks.intern({ bdt: { color: '#000', style: 1 } })).toBe(id);
        expect(looks.intern({ bdt: Object.assign({ color: '#000', style: 1 }, { width: 3 }) })).toBe(id);
        expect(Object.keys(looks.look(id).bdt ?? {})).toEqual(['style', 'color']);
        expect(looks.intern({ bdt: { style: 2, color: '#000' } })).not.toBe(id);
        expect(looks.intern({ bdt: { style: 1, color: '#001' } })).not.toBe(id);
        expect(looks.intern({ bdb: { style: 1, color: '#000' } })).not.toBe(id);
    });

    test('a key that is no look key is left out', () => {
        const looks = new LookTable();
        const id = looks.intern({ bl: 1 });
        const linked = Object.assign({ bl: 1 } satisfies CellAttrs, {
            link: { type: 'webpage', address: 'https://eigen.is' },
        });
        expect(looks.intern(linked)).toBe(id);
        expect(looks.look(id)).toEqual({ bl: 1 });
    });

    test('values are kept as given: two spellings are two looks', () => {
        const looks = new LookTable();
        expect(looks.intern({ fc: '#FFF' })).not.toBe(looks.intern({ fc: '#fff' }));
        expect(looks.intern({ ff: 1 })).not.toBe(looks.intern({ ff: '1' }));
        expect(looks.intern({ rt: 90 })).not.toBe(looks.intern({ rt: 'vertical' }));
        expect(looks.size).toBe(7);
    });

    test('every key tells two looks apart', () => {
        const looks = new LookTable();
        const ids = new Set(LOOK_KEYS.map((key) => looks.intern({ [key]: FULL[key] })));
        expect(ids.size).toBe(LOOK_KEYS.length);
        expect(ids.has(0)).toBe(false);
    });

    test('a look it hands out cannot be changed', () => {
        const looks = new LookTable();
        const given: CellAttrs = { bl: 1, bdt: { style: 1, color: '#000' } };
        const id = looks.intern(given);
        given.bl = undefined;
        expect(looks.look(id)).toEqual({ bl: 1, bdt: { style: 1, color: '#000' } });
        expect(Object.isFrozen(looks.look(id))).toBe(true);
        expect(Object.isFrozen(looks.look(id).bdt)).toBe(true);
        expect(Object.isFrozen(looks.look(0))).toBe(true);
    });

    test('a sweep keeps the worn looks in their order and tells where each id went', () => {
        const looks = new LookTable();
        const ids = ['#1', '#2', '#3', '#4', '#5'].map((bg) => looks.intern({ bg }));
        expect(ids).toEqual([1, 2, 3, 4, 5]);
        const moved = looks.sweep(new Set([2, 5]));
        expect([...moved]).toEqual([0, -1, 1, -1, -1, 2]);
        expect(looks.size).toBe(3);
        expect(looks.look(0)).toEqual({});
        expect(looks.look(1)).toEqual({ bg: '#2' });
        expect(looks.look(2)).toEqual({ bg: '#5' });
        expect(looks.intern({ bg: '#5' })).toBe(2);
        expect(looks.intern({})).toBe(0);
        // A forgotten look is a new look again.
        expect(looks.intern({ bg: '#1' })).toBe(3);
    });

    test('a sweep leaves the snapshot form of the bands as it was', () => {
        const looks = new LookTable();
        const snapshot = (bands: Bands) => {
            const content = bands.content();
            return JSON.stringify({ looks: content.looks.map((id) => looks.look(id)), bands: content.bands });
        };
        const sheets = [new Bands([], [], { runs: 0, bands: 0 }), new Bands([], [], { runs: 0, bands: 0 })];
        for (let i = 0; i < 40; i += 1) {
            const id = looks.intern({ fs: i });
            // Every third look stays worn; a later write takes the others off again.
            sheets[i % 2].write([i, i, i + 3, i + 3], () => id);
            if (i % 3 !== 0) sheets[i % 2].write([i, i, i + 3, i + 3], () => 0);
        }
        sheets[0].write([5, 0, 5, 16_383], () => looks.intern({ bl: 1 }));
        const before = sheets.map(snapshot);
        const sizeBefore = looks.size;

        const worn = new Set(sheets.flatMap((bands) => bands.content().looks));
        const moved = looks.sweep(worn);
        for (const bands of sheets) bands.write([0, 0, 1_048_575, 16_383], (id) => moved[id]);

        expect(looks.size).toBe(worn.size + 1);
        expect(looks.size).toBeLessThan(sizeBefore);
        expect(sheets.map(snapshot)).toEqual(before);
        // The ids are dense again: every one is worn or plain.
        expect(new Set(sheets.flatMap((bands) => bands.content().looks))).toEqual(
            new Set(Array.from({ length: worn.size }, (_, i) => i + 1)),
        );
    });
});
