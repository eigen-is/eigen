import { describe, expect, test } from 'bun:test';
import type { SingleRange } from '../../sheets/types';
import { coalescedRanges, MAX_VALIDATION_RANGES, wellFormedValidations } from '../../sheets/validations';

const RULE = { type: 'dropdown', type2: '', value1: 'a,b', value2: '' };
const cell = (r: number, c: number): SingleRange => ({ row: [r, r], column: [c, c] });

describe('coalescedRanges', () => {
    test('one validated cell pasted down 10,000 rows is one range', () => {
        const ranges = Array.from({ length: 10_000 }, (_, r) => cell(r, 3));
        expect(coalescedRanges(ranges)).toEqual([{ row: [0, 9999], column: [3, 3] }]);
    });

    test('a block of cells is one range, and duplicates and covered ranges of one width go', () => {
        const block = [cell(1, 2), cell(0, 1), cell(1, 1), cell(0, 2)];
        expect(coalescedRanges(block)).toEqual([{ row: [0, 1], column: [1, 2] }]);
        const repeated = [cell(4, 0), cell(4, 0), { row: [2, 6], column: [0, 0] }, cell(4, 0)];
        expect(coalescedRanges(repeated)).toEqual([{ row: [2, 6], column: [0, 0] }]);
    });

    test('ranges that do not touch stay apart, in row order', () => {
        const apart = [cell(2, 0), cell(0, 2), cell(0, 0)];
        expect(coalescedRanges(apart)).toEqual([cell(0, 0), cell(0, 2), cell(2, 0)]);
    });
});

describe('wellFormedValidations', () => {
    test('drops a rule with more ranges than the cap, and a million ranges cost no time', () => {
        const ranges = Array.from({ length: 1_000_000 }, (_, i) => cell(i % 1000, 0));
        const capped = Array.from({ length: MAX_VALIDATION_RANGES }, (_, i) => cell(i, 0));
        const started = performance.now();
        const kept = wellFormedValidations({ big: { ranges, rule: RULE }, capped: { ranges: capped, rule: RULE } });
        expect(performance.now() - started).toBeLessThan(100);
        expect(Object.keys(kept)).toEqual(['capped']);
    });

    // A numeric prompt made the xlsx export throw, and an object one would crash the hint card.
    test.each([
        ['hintValue', 5],
        ['hintValue', { x: 1 }],
        ['hintShow', 'yes'],
        ['prohibitInput', 1],
        ['rangeTxt', ['A1']],
        ['validity', null],
        ['remote', 'false'],
    ])('drops a rule whose %s is %p', (field, value) => {
        const entry = { ranges: [cell(0, 0)], rule: { ...RULE, [field]: value } };
        expect(wellFormedValidations({ v: entry })).toEqual({});
    });

    test('keeps a rule whose optional fields hold their own types', () => {
        const rule = {
            ...RULE,
            hintShow: true,
            hintValue: 'Pick one',
            prohibitInput: false,
            rangeTxt: 'A1:A3',
            validity: '',
            remote: false,
        };
        const validations = { v: { ranges: [cell(0, 0)], rule } };
        expect(wellFormedValidations(validations)).toBe(validations);
    });
});
