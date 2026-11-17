// The limits of a workbook and of what enters one: how many sheets, value slots and style runs a workbook may hold,
// with what its cells hold beyond a value weighed beside the runs, how many records and rich-text runs a sheet's parts
// may hold, and how long an id, an order key, a text and a batch of ops may be. The op validators check the bounds on
// what a peer or a file wrote, and every door that changes a workbook, such as the importer, the loader and the
// applier, weighs the result with `fits`, so every reader refuses one edit.

import { MAX_STORED_LENGTH } from '@workspace/formula/text';
import type { RefusalKey } from './refusal';

// Slots count each column's length, never its capacity.
export const MAX_VALUE_SLOTS = 4_000_000;
export const MAX_STYLE_RUNS = 4_000_000;
// A band weighs BAND_WEIGHT runs: its object and its entry.
export const BAND_WEIGHT = 32;
// A unit of what cells hold beyond a value, the bytes of one rich-text run, weighs EXTRA_WEIGHT runs.
export const EXTRA_WEIGHT = 5;

export const MAX_ID_LENGTH = 64;
export const MAX_ORDER_KEY = 64;

// A batch as JSON writes it, in UTF-16 code units, less the content of its sheet adds, which `fits` bounds; a text a
// cell or a field holds; a short text such as a color, a number format or a font name.
export const MAX_BATCH_JSON = 4 * 1024 * 1024;
export const MAX_TEXT_LENGTH = MAX_STORED_LENGTH;
export const MAX_SHORT_TEXT = 256;

// Records of one type on one sheet.
export const MAX_RECORDS_PER_TYPE = 100_000;
// Rich-text runs in one cell.
export const MAX_RUNS_PER_CELL = 1_000;
export const MAX_SHEETS = 1_000;
// Inside a batch a workbook may pass each limit up to this many times it: a workbook that fits and a result that fits
// are together at most twice a limit, so a write is weighed without what its op frees.
export const MIDWAY = 2;

// `extras` is the units of what cells hold beyond a value; `records` is the most records of one type on one sheet.
export type WorkbookWeight = {
    readonly slots: number;
    readonly runs: number;
    readonly bands: number;
    readonly extras: number;
    readonly records: number;
    readonly sheets: number;
};

// What the limit on formats counts, in runs: the runs, the bands and what cells hold beyond a value.
export function formatsOf({ runs, bands, extras }: Pick<WorkbookWeight, 'runs' | 'bands' | 'extras'>): number {
    return runs + bands * BAND_WEIGHT + extras * EXTRA_WEIGHT;
}

// The first limit a workbook of this weight is over, or null: the limits as they are for a workbook a batch leaves,
// `times` each for one inside a batch.
export function fits(weight: WorkbookWeight, times = 1): RefusalKey | null {
    if (weight.slots > times * MAX_VALUE_SLOTS) return 'too-many-cells';
    if (formatsOf(weight) > times * MAX_STYLE_RUNS) return 'too-many-formats';
    if (weight.records > times * MAX_RECORDS_PER_TYPE) return 'too-many-records';
    if (weight.sheets > times * MAX_SHEETS) return 'too-many-sheets';
    return null;
}
