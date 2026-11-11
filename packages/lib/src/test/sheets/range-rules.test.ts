import { describe, expect, test } from 'bun:test';
import {
    coalescedRanges,
    MAX_RULE_RANGES,
    MAX_VALIDATIONS,
    nextRuleOrder,
    orderedRules,
    wellFormedConditionalFormats,
    wellFormedValidations,
} from '../../sheets/range-rules';
import type { SingleRange } from '../../sheets/types';

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
        const capped = Array.from({ length: MAX_RULE_RANGES }, (_, i) => cell(i, 0));
        const started = performance.now();
        const kept = wellFormedValidations({
            big: { ranges, order: 'a0', rule: RULE },
            capped: { ranges: capped, order: 'a1', rule: RULE },
        });
        expect(performance.now() - started).toBeLessThan(100);
        expect(Object.keys(kept)).toEqual(['capped']);
    });

    test('keeps the first in order of a sheet with more rules than a sheet may hold', () => {
        const rules = Object.fromEntries(
            Array.from({ length: MAX_VALIDATIONS + 2 }, (_, i) => [
                `v${i}`,
                { ranges: [cell(i, 0)], order: i === 0 ? 'a1' : i === 7 ? 'Zz' : 'a0', rule: RULE },
            ]),
        );
        const kept = Object.keys(wellFormedValidations(rules));
        expect(kept).toHaveLength(MAX_VALIDATIONS);
        expect(kept).not.toContain('v0');
        expect(kept).not.toContain('v999');
        expect(kept[0]).toBe('v7');
    });

    // A numeric prompt made the xlsx export throw, and an object one would crash the hint card.
    test.each([
        ['hintValue', 5],
        ['hintValue', { x: 1 }],
        ['hintShow', 'yes'],
        ['prohibitInput', 1],
    ])('drops a rule whose %s is %p', (field, value) => {
        const entry = { ranges: [cell(0, 0)], order: 'a0', rule: { ...RULE, [field]: value } };
        expect(wellFormedValidations({ v: entry })).toEqual({});
    });

    test('keeps a rule whose optional fields hold their own types', () => {
        const rule = {
            ...RULE,
            hintShow: true,
            hintValue: 'Pick one',
            prohibitInput: false,
        };
        const validations = { v: { ranges: [cell(0, 0)], order: 'a0', rule } };
        expect(wellFormedValidations(validations)).toBe(validations);
    });
});

describe('wellFormedConditionalFormats', () => {
    const format = { type: 'dataBar', ranges: [cell(0, 0)], order: 'a0', format: ['#638ec6'] };

    test('keeps a record of well-formed rules as it is, and drops a rule no reader can read', () => {
        const formats = { f: format };
        expect(wellFormedConditionalFormats(formats) === formats).toBe(true);
        const kept = wellFormedConditionalFormats({
            f: format,
            noOrder: { ...format, order: undefined },
            badOrder: { ...format, order: 'a0 ' },
            unknownType: { ...format, type: 'icons' },
            noValues: { ...format, type: 'default', format: {}, conditionName: 'equal' },
            pastTheGrid: { ...format, ranges: [{ row: [0, 1048576], column: [0, 0] }] },
        });
        expect(Object.keys(kept)).toEqual(['f']);
    });

    // Making the next key walks the last one character by character, so a forged key of 40,000 characters would make
    // every later add of a rule throw.
    test('drops a rule whose order key is longer than any writer makes, so the next rule still gets a key', () => {
        const order = `z${'z'.repeat(26)}${'z'.repeat(40_000)}`;
        const kept = wellFormedConditionalFormats({ f: format, forged: { ...format, order } });
        expect(Object.keys(kept)).toEqual(['f']);
        expect(nextRuleOrder(kept)).toBe('a1');
    });

    // A write by id never reaches an own `__proto__` key, so a rule stored under it could not be deleted.
    test('drops a rule under the id __proto__, from a record that is otherwise well formed too', () => {
        const stored = JSON.parse(`{"f":${JSON.stringify(format)},"__proto__":${JSON.stringify(format)}}`);
        expect(Object.keys(stored)).toEqual(['f', '__proto__']);
        expect(Object.keys(wellFormedConditionalFormats(stored))).toEqual(['f']);
        const validation = { ranges: [cell(0, 0)], order: 'a0', rule: RULE };
        const validations = JSON.parse(`{"__proto__":${JSON.stringify(validation)}}`);
        expect(Object.keys(wellFormedValidations(validations))).toEqual([]);
    });

    test.each([
        ['textColor', 5],
        ['cellColor', { x: 1 }],
    ])('drops a rule whose %s is %p, and keeps one whose color is text, null or absent', (field, value) => {
        const rule = {
            type: 'default',
            ranges: [cell(0, 0)],
            order: 'a0',
            conditionName: 'equal',
            conditionValue: [1],
        };
        const kept = wellFormedConditionalFormats({
            bad: { ...rule, format: { [field]: value } },
            text: { ...rule, format: { [field]: '#ff0000' } },
            none: { ...rule, format: { [field]: null } },
            absent: { ...rule, format: {} },
        });
        expect(Object.keys(kept).sort()).toEqual(['absent', 'none', 'text']);
    });
});

describe('orderedRules', () => {
    test('rules go by their order key, and rules two peers gave one key by id', () => {
        const rules = { b: { order: 'a1' }, z: { order: 'a0' }, a: { order: 'a1' }, c: { order: 'Zz' } };
        expect(orderedRules(rules).map(([id]) => id)).toEqual(['c', 'z', 'a', 'b']);
        expect(orderedRules(undefined)).toEqual([]);
    });

    test('a new rule takes a key after the last, on tied keys too', () => {
        expect(nextRuleOrder({})).toBe('a0');
        const next = nextRuleOrder({ a: { order: 'a1' }, b: { order: 'a1' }, c: { order: 'a0' } });
        expect(next > 'a1').toBe(true);
    });
});
