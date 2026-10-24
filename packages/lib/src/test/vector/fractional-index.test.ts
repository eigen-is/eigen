import { describe, expect, test } from 'bun:test';
import type { ZOp } from '../../vector/fractional-index';
import {
    generateKeyBetween,
    generateNKeysBetween,
    isValidFractionalIndex,
    keysAfter,
    orderByFractionalIndex,
    syncInvalidIndices,
    validateOrderKey,
    zOrderKeys,
} from '../../vector/fractional-index';

const isSorted = (keys: string[]) => keys.every((k, i) => i === 0 || keys[i - 1] < k);

describe('generateKeyBetween', () => {
    test('first key with both bounds null is "a0"', () => {
        expect(generateKeyBetween(null, null)).toBe('a0');
    });

    test('produces a key strictly between its bounds', () => {
        const a = generateKeyBetween(null, null);
        const b = generateKeyBetween(a, null);
        expect(a < b).toBe(true);
        const mid = generateKeyBetween(a, b);
        expect(a < mid && mid < b).toBe(true);
    });
});

describe('generateNKeysBetween', () => {
    test('returns n distinct sorted keys', () => {
        const keys = generateNKeysBetween(null, null, 4);
        expect(keys).toHaveLength(4);
        expect(new Set(keys).size).toBe(4);
        expect(isSorted(keys)).toBe(true);
    });
});

describe('orderByFractionalIndex', () => {
    test('sorts by index, tie-breaks on id, does not mutate input', () => {
        const input = [
            { id: 'x', index: 'a2' },
            { id: 'b', index: 'a1' },
            { id: 'a', index: 'a1' },
        ];
        const sorted = orderByFractionalIndex(input);
        expect(sorted.map((e) => e.id)).toEqual(['a', 'b', 'x']);
        // untouched original order
        expect(input.map((e) => e.id)).toEqual(['x', 'b', 'a']);
    });
});

describe('isValidFractionalIndex', () => {
    test('validates format and strict between-bounds ordering', () => {
        expect(isValidFractionalIndex('a1', 'a0', 'a2')).toBe(true);
        expect(isValidFractionalIndex('a0', 'a1', 'a2')).toBe(false); // not > predecessor
        expect(isValidFractionalIndex('a2', 'a0', 'a1')).toBe(false); // not < successor
        expect(isValidFractionalIndex('', undefined, undefined)).toBe(false); // empty
        expect(isValidFractionalIndex('not a key', undefined, undefined)).toBe(false); // malformed
        expect(isValidFractionalIndex('a0', undefined, undefined)).toBe(true); // sole element
    });
});

describe('syncInvalidIndices', () => {
    const assertHealed = (els: { id: string; index: string }[]) => {
        for (let i = 0; i < els.length; i++) {
            expect(isValidFractionalIndex(els[i].index, els[i - 1]?.index, els[i + 1]?.index)).toBe(true);
            expect(() => validateOrderKey(els[i].index)).not.toThrow();
        }
    };

    test('repairs a duplicate index, preserving order and valid neighbours', () => {
        const els = [
            { id: 'a', index: 'a0' },
            { id: 'b', index: 'a0' }, // duplicate
            { id: 'c', index: 'a1' },
        ];
        syncInvalidIndices(els);
        expect(els.map((e) => e.id)).toEqual(['a', 'b', 'c']);
        expect(els[0].index).toBe('a0');
        expect(els[2].index).toBe('a1');
        expect(els[0].index < els[1].index && els[1].index < els[2].index).toBe(true);
        assertHealed(els);
    });

    test('repairs an empty (missing) index between valid bounds', () => {
        const els = [
            { id: 'a', index: 'a0' },
            { id: 'b', index: '' },
            { id: 'c', index: 'a2' },
        ];
        syncInvalidIndices(els);
        expect(els[0].index).toBe('a0');
        expect(els[2].index).toBe('a2');
        assertHealed(els);
    });

    test('repairs an all-invalid run into consecutive keys', () => {
        const els = [
            { id: 'a', index: '' },
            { id: 'b', index: 'garbage key' },
            { id: 'c', index: '' },
        ];
        syncInvalidIndices(els);
        assertHealed(els);
        expect(new Set(els.map((e) => e.index)).size).toBe(3);
    });

    test('leaves already-valid indices untouched', () => {
        const els = [
            { id: 'a', index: 'a0' },
            { id: 'b', index: 'a1' },
            { id: 'c', index: 'a2' },
        ];
        syncInvalidIndices(els);
        expect(els.map((e) => e.index)).toEqual(['a0', 'a1', 'a2']);
    });
});

describe('keysAfter', () => {
    // B and C share a key, as two peers' inserts after A leave them: ordered by key then id.
    const order = orderByFractionalIndex([
        { id: 'D', index: 'a2' },
        { id: 'C', index: 'a1' },
        { id: 'B', index: 'a1' },
        { id: 'A', index: 'a0' },
    ]);

    test('places after the anchor, before the next key', () => {
        const [key] = keysAfter(order, 'A', 1);
        expect('a0' < key && key < 'a1').toBe(true);
    });

    test('after a tied anchor goes above the whole tie, never throwing', () => {
        for (const id of ['B', 'C']) {
            const keys = keysAfter(order, id, 2);
            expect(isSorted(['a1', ...keys, 'a2'])).toBe(true);
        }
    });

    test('null is the front, an unknown id the end', () => {
        expect(keysAfter(order, null, 1)[0] < 'a0').toBe(true);
        expect(keysAfter(order, 'gone', 1)[0] > 'a2').toBe(true);
        expect(keysAfter([], 'gone', 2)).toEqual(['a0', 'a1']);
    });
});

describe('zOrderKeys', () => {
    const ZOPS: ZOp[] = ['forward', 'backward', 'toFront', 'toBack'];
    const keyed = (ids: string, keys: string[]) => [...ids].map((id, i) => ({ id, index: keys[i] }));
    // The paint order once the writes land, bottom first.
    const paintOrder = (elements: { id: string; index: string }[], selectedIds: string[], op: ZOp) => {
        const writes = new Map(zOrderKeys(elements, selectedIds, op).map((w) => [w.id, w.index]));
        const next = elements.map((e) => ({ id: e.id, index: writes.get(e.id) ?? e.index }));
        return orderByFractionalIndex(next)
            .map((e) => e.id)
            .join('');
    };
    // One element's step or jump in the list, the result every op must reach.
    const moved = (order: string, id: string, op: ZOp) => {
        const rest = [...order].filter((c) => c !== id);
        const at = order.indexOf(id);
        const to = { forward: at + 1, backward: at - 1, toFront: rest.length, toBack: 0 }[op];
        rest.splice(Math.max(0, Math.min(rest.length, to)), 0, id);
        return rest.join('');
    };

    const ABCD = keyed('abcd', ['a0', 'a1', 'a2', 'a3']);

    test.each(ZOPS)('%s moves one element one step or to the edge, writing only its key', (op) => {
        for (const id of 'bc') {
            expect(paintOrder(ABCD, [id], op)).toBe(moved('abcd', id, op));
            expect(zOrderKeys(ABCD, [id], op).map((w) => w.id)).toEqual([id]);
        }
    });

    test('a non-contiguous selection moves as one block past its next neighbour', () => {
        expect(paintOrder(ABCD, ['a', 'c'], 'forward')).toBe('bdac');
        expect(paintOrder(ABCD, ['b', 'd'], 'backward')).toBe('bdac');
        expect(paintOrder(ABCD, ['a', 'c'], 'toFront')).toBe('bdac');
        expect(paintOrder(ABCD, ['b', 'd'], 'toBack')).toBe('bdac');
    });

    test('at the edge, with nothing selected, or with everything selected it writes nothing', () => {
        expect(zOrderKeys(ABCD, ['d'], 'forward')).toEqual([]);
        expect(zOrderKeys(ABCD, ['a'], 'backward')).toEqual([]);
        expect(zOrderKeys(ABCD, [], 'toFront')).toEqual([]);
        expect(zOrderKeys(ABCD, ['a', 'b', 'c', 'd'], 'forward')).toEqual([]);
        expect(zOrderKeys(ABCD, ['a', 'b', 'c', 'd'], 'backward')).toEqual([]);
    });

    // Two peers inserting at once can write the same key; malformed keys come from a schemaless store.
    const TIED = [
        keyed('pqrs', ['a0', 'a0', 'a0', 'a1']),
        keyed('pqrs', ['a0', 'a1', 'a1', 'a1']),
        keyed('pqrs', ['a0', 'a0', 'a1', 'a1']),
        keyed('pqrs', ['a1', 'a1', 'a1', 'a1']),
        keyed('pqrs', ['a0', '', 'garbage', 'a1']),
    ];

    test.each(ZOPS)('%s on tied or malformed keys never throws and moves from the order they read in', (op) => {
        for (const elements of TIED) {
            const before = orderByFractionalIndex(elements)
                .map((e) => e.id)
                .join('');
            for (const id of 'pqrs') {
                expect(paintOrder(elements, [id], op)).toBe(moved(before, id, op));
            }
        }
    });

    test('a tie between two peers resolves the same whichever order they arrive in', () => {
        const peers = keyed('xyz', ['a0', 'a0', 'a1']);
        const reversed = [...peers].reverse();
        expect(zOrderKeys(reversed, ['z'], 'backward')).toEqual(zOrderKeys(peers, ['z'], 'backward'));
        expect(paintOrder(peers, ['z'], 'backward')).toBe('xzy');
    });
});
