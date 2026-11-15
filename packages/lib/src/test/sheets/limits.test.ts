import { describe, expect, test } from 'bun:test';
import { MAX_STORED_LENGTH } from '@workspace/formula/text';
import {
    BAND_WEIGHT,
    EXTRA_WEIGHT,
    fits,
    MAX_BATCH_JSON,
    MAX_ID_LENGTH,
    MAX_ORDER_KEY,
    MAX_RECORDS_PER_TYPE,
    MAX_RUNS_PER_CELL,
    MAX_SHEETS,
    MAX_SHORT_TEXT,
    MAX_STYLE_RUNS,
    MAX_TEXT_LENGTH,
    MAX_VALUE_SLOTS,
} from '../../sheets/limits';

const EMPTY = { slots: 0, runs: 0, bands: 0, extras: 0, records: 0, sheets: 1 };

describe('fits', () => {
    test('a workbook at every limit fits', () => {
        expect(fits({ ...EMPTY, slots: MAX_VALUE_SLOTS, runs: MAX_STYLE_RUNS })).toBeNull();
        expect(fits({ ...EMPTY, runs: MAX_STYLE_RUNS - 10 * BAND_WEIGHT, bands: 10 })).toBeNull();
        expect(fits({ ...EMPTY, records: MAX_RECORDS_PER_TYPE, sheets: MAX_SHEETS })).toBeNull();
    });

    test('one value slot past the limit is too many cells', () => {
        expect(fits({ ...EMPTY, slots: MAX_VALUE_SLOTS + 1 })).toBe('too-many-cells');
    });

    test('a band weighs BAND_WEIGHT runs', () => {
        expect(fits({ ...EMPTY, runs: MAX_STYLE_RUNS - 10 * BAND_WEIGHT + 1, bands: 10 })).toBe('too-many-formats');
        expect(fits({ ...EMPTY, runs: MAX_STYLE_RUNS + 1 })).toBe('too-many-formats');
    });

    test('a unit of what cells hold beyond a value weighs EXTRA_WEIGHT runs, in the budget of the looks', () => {
        const units = (MAX_STYLE_RUNS - 10 * BAND_WEIGHT - 5) / EXTRA_WEIGHT;
        expect(fits({ ...EMPTY, runs: 5, bands: 10, extras: units })).toBeNull();
        expect(fits({ ...EMPTY, runs: 6, bands: 10, extras: units })).toBe('too-many-formats');
        expect(fits({ ...EMPTY, runs: 5, bands: 10, extras: units + 1 })).toBe('too-many-formats');
        expect(fits({ ...EMPTY, extras: MAX_STYLE_RUNS / EXTRA_WEIGHT + 1 })).toBe('too-many-formats');
    });

    test('one record of a type on a sheet past the limit is too many records', () => {
        expect(fits({ ...EMPTY, records: MAX_RECORDS_PER_TYPE + 1 })).toBe('too-many-records');
    });

    test('one sheet past the limit is too many sheets', () => {
        expect(fits({ ...EMPTY, sheets: MAX_SHEETS + 1 })).toBe('too-many-sheets');
    });

    test('too many cells is told before too many formats', () => {
        expect(fits({ ...EMPTY, slots: MAX_VALUE_SLOTS + 1, runs: MAX_STYLE_RUNS + 1 })).toBe('too-many-cells');
    });
});

describe('the limits', () => {
    test('hold the ruled numbers', () => {
        expect([MAX_VALUE_SLOTS, MAX_STYLE_RUNS, BAND_WEIGHT, EXTRA_WEIGHT]).toEqual([4_000_000, 4_000_000, 32, 5]);
        expect([MAX_ID_LENGTH, MAX_ORDER_KEY, MAX_SHORT_TEXT]).toEqual([64, 64, 256]);
        expect(MAX_TEXT_LENGTH).toBe(MAX_STORED_LENGTH);
        expect(MAX_BATCH_JSON).toBe(4 * 1024 * 1024);
    });

    test('hold the counts of records, runs and sheets', () => {
        expect([MAX_RECORDS_PER_TYPE, MAX_RUNS_PER_CELL, MAX_SHEETS]).toEqual([100_000, 1_000, 1_000]);
    });
});
