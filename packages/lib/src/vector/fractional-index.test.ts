import { describe, expect, test } from 'bun:test';
import {
    generateKeyBetween,
    generateNKeysBetween,
    isValidFractionalIndex,
    orderByFractionalIndex,
    syncInvalidIndices,
    validateOrderKey,
} from './fractional-index';

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
