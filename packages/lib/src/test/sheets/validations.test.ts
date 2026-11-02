import { describe, expect, test } from 'bun:test';
import type { SingleRange } from '../../sheets/types';
import { wellFormedValidations } from '../../sheets/validations';

const RULE = { type: 'dropdown', type2: '', value1: 'a,b', value2: '' };
const cell = (r: number, c: number): SingleRange => ({ row: [r, r], column: [c, c] });

describe('wellFormedValidations', () => {
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
