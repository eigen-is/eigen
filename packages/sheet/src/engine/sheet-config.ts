import type { Sheet } from '@workspace/lib/sheets';
import type { ExtendedSheetConfig } from './types';

// immer records the creation of a key as one `add` carrying the WHOLE new value, so a config
// collection that does not exist yet turns the first write to it into a whole-collection op —
// two clients each making their first row resize overwrite each other. Writers therefore emit
// granular `['config','rowlen','2']` patches against collections that already exist, so every
// sheet entering any consumer (initSheetData, the replay base, addSheet ops, createDefaultSheets)
// is normalized here first; a base missing a collection makes those patches fail to resolve and
// drops the batch. A leaf of its own so `defaults.ts` can normalize without cycling through the
// replay machinery.
//
// One list — a collection missing from it silently reintroduces the clobber for its own first
// write. `satisfies` only checks each entry is a real key; the assert below checks the reverse.
export const SHEET_CONFIG_COLLECTIONS = [
    'merge',
    'rowlen',
    'columnlen',
    'rowhidden',
    'colhidden',
    'customHeight',
    'customWidth',
    'rowReadOnly',
    'colReadOnly',
    'borderInfo',
] as const satisfies readonly (keyof ExtendedSheetConfig)[];

// Exhaustiveness gate: every Record-valued (collection) key of ExtendedSheetConfig must appear
// above, or a new collection's first write returns to clobbering peers. Membership (`satisfies`)
// does not catch an omission; this does — Exclude is non-never the moment a collection is missing,
// and `true` stops being assignable. Scalar keys are Record-excluded, so they need no entry.
type CollectionConfigKey = {
    [K in keyof ExtendedSheetConfig]-?: NonNullable<ExtendedSheetConfig[K]> extends Record<string, unknown> ? K : never;
}[keyof ExtendedSheetConfig];
const _allCollectionsListed: Exclude<CollectionConfigKey, (typeof SHEET_CONFIG_COLLECTIONS)[number]> extends never
    ? true
    : false = true;
void _allCollectionsListed;

export function normalizeSheetConfig(sheet: Sheet) {
    // `Sheet.config` is lib's wire shape; the editor extras ride along on the same object.
    const cfg = (sheet.config ??= {}) as ExtendedSheetConfig;
    for (const key of SHEET_CONFIG_COLLECTIONS) cfg[key] ??= {};
}
