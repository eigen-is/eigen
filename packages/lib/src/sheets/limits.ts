// The limits of a workbook and of what enters one: how many value slots and style runs a workbook may hold, and how
// long an id, an order key, a text and a batch of ops may be. The op validators check the bounds on what a peer or a
// file wrote, and every door that changes a workbook, such as the importer, the loader and the applier, weighs the
// result with `fits`, so every reader refuses the same edit.

import { MAX_STORED_LENGTH } from '@workspace/formula/text';
import type { RefusalKey } from './refusal';

// RULED by the owner. Slots count each column's length, never its capacity.
export const MAX_VALUE_SLOTS = 4_000_000;
// RULED by the owner. A band weighs BAND_WEIGHT runs: its object and its entry.
export const MAX_STYLE_RUNS = 4_000_000;
export const BAND_WEIGHT = 32;

// Settled.
export const MAX_ID_LENGTH = 64;
export const MAX_ORDER_KEY = 64;

// RULED by the owner: a batch's JSON text in UTF-16 code units, a batch of sheet ops alone left out since a sheet's add
// has bounds of its own; a text a cell or a field holds; a short text such as a color, a number format or a font name.
export const MAX_BATCH_JSON = 4 * 1024 * 1024;
export const MAX_TEXT_LENGTH = MAX_STORED_LENGTH;
export const MAX_SHORT_TEXT = 256;

export type WorkbookWeight = { readonly slots: number; readonly runs: number; readonly bands: number };

export function fits(weight: WorkbookWeight): RefusalKey | null {
    if (weight.slots > MAX_VALUE_SLOTS) return 'too-many-cells';
    if (weight.runs + weight.bands * BAND_WEIGHT > MAX_STYLE_RUNS) return 'too-many-formats';
    return null;
}
