// Gives a sheet every collection the editor writes into key by key: the config maps, such as merges and row heights,
// and the images, charts and validation rules beside them. immer records the creation of a key as one `add` of the
// whole new value, so a first write into a missing collection would ship the collection whole, and two peers' first
// row resizes would overwrite each other. So every sheet that enters a reader, such as the editor's mount, the replay
// base, an addSheet op or the default workbook, passes through normalizeSheetConfig first.

import { isRecord } from '@workspace/lib/guards';
import type { Sheet } from '@workspace/lib/sheets';
import { chartsWithinEntryCap, wellFormedValidations } from '@workspace/lib/sheets';
import type { ExtendedSheetConfig } from './types';

// One list: a collection missing from it brings the overwrite back for its own first write. `satisfies` only checks
// that each entry is a real key, and the check below it checks the reverse. The file is a leaf of its own, so the
// default workbook can normalize without a cycle through the replay.
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

// Every map-valued key of ExtendedSheetConfig must be in the list above. When one is missing, the Exclude below is no
// longer never, `true` is no longer assignable, and the build fails. A scalar key is no map, so it needs no entry.
type CollectionConfigKey = {
    [K in keyof ExtendedSheetConfig]-?: NonNullable<ExtendedSheetConfig[K]> extends Record<string, unknown> ? K : never;
}[keyof ExtendedSheetConfig];
const _allCollectionsListed: Exclude<CollectionConfigKey, (typeof SHEET_CONFIG_COLLECTIONS)[number]> extends never
    ? true
    : false = true;
void _allCollectionsListed;

export function normalizeSheetConfig(sheet: Sheet) {
    // `Sheet.config` is lib's wire shape; the editor extras ride along on the same object.
    const cfg: ExtendedSheetConfig = (sheet.config ??= {});
    for (const key of SHEET_CONFIG_COLLECTIONS) cfg[key] ??= {};
    // Images, charts and validation rules live outside config but are written per key the same way. A value that is
    // no map, a chart past the entry cap or a rule that is not well formed only a forged sheet holds: it is left out,
    // as the op conversion leaves out a write that brings one.
    sheet.images = isRecord(sheet.images) ? sheet.images : {};
    sheet.charts = isRecord(sheet.charts) ? chartsWithinEntryCap(sheet.charts) : {};
    sheet.dataValidations = wellFormedValidations(sheet.dataValidations);
}
