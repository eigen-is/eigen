import { describe, expect, test } from 'bun:test';
import { ApiError } from '../../lib/core/errors';
import { budget } from '../../lib/ooxml/budget';

describe('a budget', () => {
    test('charges up to its limit, and past it refuses the file with its own 413', () => {
        const work = budget(10, 'Too large');
        work.charge(4);
        work.charge(6);
        expect(() => work.charge(1)).toThrow(new ApiError(413, 'Too large'));
    });

    test('answers whether what is left covers an amount, charging nothing', () => {
        const work = budget(10, 'Too large');
        expect([work.affords(10), work.affords(11)]).toEqual([true, false]);
        work.charge(4);
        expect([work.affords(6), work.affords(7)]).toEqual([true, false]);
    });

    test('spends an amount what is left covers, and none of one it does not', () => {
        const work = budget(10, 'Too large');
        expect(work.spend(11)).toBe(false);
        expect(work.spend(4)).toBe(true);
        expect([work.affords(6), work.affords(7)]).toEqual([true, false]);
        expect(work.spend(6)).toBe(true);
        expect(work.spend(1)).toBe(false);
    });

    test('a charge that is no count of work refuses the file, and the budget stays spent', () => {
        for (const units of [Number.NaN, Number.POSITIVE_INFINITY, -1]) {
            const work = budget(Number.POSITIVE_INFINITY, 'Too large');
            expect(() => work.charge(units)).toThrow(new ApiError(413, 'Too large'));
            expect(() => work.charge(0)).toThrow(new ApiError(413, 'Too large'));
            expect(work.affords(0)).toBe(false);
        }
    });

    test('affords and spends no amount that is no count of work', () => {
        const work = budget(10, 'Too large');
        for (const units of [Number.NaN, Number.NEGATIVE_INFINITY, -1]) {
            expect([work.affords(units), work.spend(units)]).toEqual([false, false]);
        }
        expect([work.affords(10), work.affords(11)]).toEqual([true, false]);
    });

    test('without a limit never refuses', () => {
        const work = budget(Number.POSITIVE_INFINITY, 'Too large');
        work.charge(Number.MAX_SAFE_INTEGER);
        expect(work.spend(Number.MAX_SAFE_INTEGER)).toBe(true);
    });
});
