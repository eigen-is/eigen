// Gives a sheet every collection the editor writes into key by key: the config maps, such as merges and row heights,
// and the images, charts and rules beside them. immer records the creation of a key as one `add` of the whole new
// value, so a first write into a missing collection would ship it whole, and two peers' first row resizes would
// overwrite each other. So every sheet that enters a reader, such as the editor's mount, the replay base or an
// addSheet op, passes through normalizeSheetConfig first.

import { isRecord } from '@workspace/lib/guards';
import type { Sheet } from '@workspace/lib/sheets';
import { wellFormedConditionalFormats, wellFormedValidations } from '@workspace/lib/sheets';
import type { ExtendedSheetConfig } from './types';

// One list: a collection missing from it brings the overwrite back for its own first write. `satisfies` checks that
// each entry is a real key, and the check below it the reverse.
export const SHEET_CONFIG_COLLECTIONS = [
    'merge',
    'rowlen',
    'columnlen',
    'rowhidden',
    'colhidden',
    'customHeight',
    'customWidth',
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
    // Images, charts and rules live outside config but are written per key the same way. Only a forged sheet holds a
    // value that is no map or a rule that is not well formed, and it is left out.
    sheet.images = isRecord(sheet.images) ? sheet.images : {};
    sheet.charts = isRecord(sheet.charts) ? sheet.charts : {};
    sheet.conditionalFormats = wellFormedConditionalFormats(sheet.conditionalFormats);
    sheet.dataValidations = wellFormedValidations(sheet.dataValidations);
}
