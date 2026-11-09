import { describe, expect, test } from 'bun:test';
// @ts-expect-error - No types available for @formulajs/formulajs
import * as formulajs from '@formulajs/formulajs';
import SUPPORTED_FORMULAS from '../../../../engine/parser/supported-formulas';

describe('sheet/formula-parser/supported-formulas', () => {
    test('should be defined', () => {
        expect(SUPPORTED_FORMULAS.length).toBe(412);
    });

    // The engine overrides TEXT with its own, so formulajs's stub never runs.
    test('registers no stub, which would answer #ERROR! where a function this build lacks answers #NAME?', () => {
        const stubs = Object.entries(formulajs).filter(([name, fn]) => {
            return SUPPORTED_FORMULAS.includes(name) && /not implemented/i.test(String(fn));
        });
        expect(stubs.map(([name]) => name)).toEqual(['TEXT']);
    });
});
