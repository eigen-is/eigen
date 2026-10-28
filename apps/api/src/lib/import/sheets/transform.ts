// The xlsx import's step in the transform process: the reader's sheets weighed, recalculated and encoded as the lean
// snapshot JSON the main thread commits. The pictures its images name come beside it, and the main thread writes them
// through Drive. The reader's caps refuse a file with their own 413s, and a failed recalc comes back as a warning, never
// a failed import.

import type { Sheet } from '@workspace/lib/sheets';
import { encodeSheetsSnapshot } from '@workspace/lib/sheets';
import { recalcSheets } from '@workspace/sheet/engine';
import { SERVER_RECALC_BUDGET } from '../../document/sheets';
import type { SheetsImportJob, SheetsImportTransformResult, TransformWarning } from '../../document/transform/protocol';
import { toTransferableMedia, toTransferableText } from '../../document/transform/protocol';
import { readXlsx } from './from-xlsx';
import { sheetsWeight } from './limits';

export function importXlsxToSheetsSnapshot(
    data: ArrayBuffer,
    job: Pick<SheetsImportJob, 'maxMediaBytes'>,
): SheetsImportTransformResult & { warnings: TransformWarning[] } {
    const read = readXlsx(new Uint8Array(data), job);
    // Weighed before the recalc, which may lengthen a formula's result, so the weight never passes what the reader let
    // through.
    const weight = sheetsWeight(read.sheets);
    const { sheets, computed } = recalcImportedSheets(read.sheets, read.warnings);
    return {
        snapshotJson: toTransferableText(encodeSheetsSnapshot(sheets, { computed })),
        weight,
        images: toTransferableMedia(read.media),
        warnings: read.warnings,
    };
}

// The recalc reconciles the values Excel cached with the engine's, so a later read needn't compute the sheets again.
// Only a recalc that succeeded is stored as computed. A failure stores the sheets uncomputed with a warning, and an
// export recalcs them under the same budget.
function recalcImportedSheets(sheets: Sheet[], warnings: TransformWarning[]): { sheets: Sheet[]; computed: boolean } {
    try {
        return { sheets: recalcSheets(sheets, SERVER_RECALC_BUDGET), computed: true };
    } catch (err) {
        warnings.push({ code: 'recalc-failed', message: err instanceof Error ? err.message : String(err) });
        return { sheets, computed: false };
    }
}
