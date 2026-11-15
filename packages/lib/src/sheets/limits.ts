// The limits of a workbook and of what enters one: how many sheets, value slots and style runs a workbook may hold, how
// many records and rich-text runs a sheet's parts may hold, and how long an id, an order key, a text and a batch of ops
// may be. The op validators check the bounds on what a peer or a file wrote, and every door that changes a workbook,
// such as the importer, the loader and the applier, weighs the result with `fits`, so every reader refuses one edit.

import { MAX_STORED_LENGTH } from '@workspace/formula/text';
import type { RefusalKey } from './refusal';

// Slots count each column's length, never its capacity.
export const MAX_VALUE_SLOTS = 4_000_000;
// A band weighs BAND_WEIGHT runs: its object and its entry.
export const MAX_STYLE_RUNS = 4_000_000;
export const BAND_WEIGHT = 32;

export const MAX_ID_LENGTH = 64;
export const MAX_ORDER_KEY = 64;

// A batch as JSON writes it, in UTF-16 code units, less the content of its sheet adds, which `fits` bounds; a text a
// cell or a field holds; a short text such as a color, a number format or a font name.
export const MAX_BATCH_JSON = 4 * 1024 * 1024;
export const MAX_TEXT_LENGTH = MAX_STORED_LENGTH;
export const MAX_SHORT_TEXT = 256;

// Records of one type on one sheet.
export const MAX_RECORDS_PER_TYPE = 100_000;
// Rich-text runs in one cell, which `fits` does not weigh.
export const MAX_RUNS_PER_CELL = 1_000;
export const MAX_SHEETS = 1_000;

// `records` is the most records of one type on one sheet.
export type WorkbookWeight = {
    readonly slots: number;
    readonly runs: number;
    readonly bands: number;
    readonly records: number;
    readonly sheets: number;
};

export function fits(weight: WorkbookWeight): RefusalKey | null {
    if (weight.slots > MAX_VALUE_SLOTS) return 'too-many-cells';
    if (weight.runs + weight.bands * BAND_WEIGHT > MAX_STYLE_RUNS) return 'too-many-formats';
    if (weight.records > MAX_RECORDS_PER_TYPE) return 'too-many-records';
    if (weight.sheets > MAX_SHEETS) return 'too-many-sheets';
    return null;
}
