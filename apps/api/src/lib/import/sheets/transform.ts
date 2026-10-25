import type { Sheet } from '@workspace/lib/sheets';
import { encodeSheetsSnapshot } from '@workspace/lib/sheets';
import { recalcSheets } from '@workspace/sheet/engine';
import { SERVER_RECALC_BUDGET } from '../../document/sheets';
import type { SheetsImportJob, SheetsImportWorkerResult, TransformWarning } from '../../document/transform/protocol';
import { toTransferableMedia, toTransferableText } from '../../document/transform/protocol';
import { readXlsx } from './from-xlsx';

// Uploaded xlsx bytes → the lean snapshot JSON the main thread commits, and the pictures its images name, which it
// writes through Mount. Runs inside the transform process (child.ts owns execution; the conversion logic stays here in
// import/, pure over the buffer). The reader's caps ride along inside readXlsx with their exact 413s, and a recalc
// failure comes back as a warning — an import must never fail because recalc hiccuped.
export function importXlsxToSheetsSnapshot(
    data: ArrayBuffer,
    job: Pick<SheetsImportJob, 'maxMediaBytes'>,
): SheetsImportWorkerResult & { warnings: TransformWarning[] } {
    const read = readXlsx(new Uint8Array(data), job);
    const { sheets, computed } = recalcImportedSheets(read.sheets, read.warnings);
    return {
        snapshotJson: toTransferableText(encodeSheetsSnapshot(sheets, { computed })),
        images: toTransferableMedia(read.media),
        warnings: read.warnings,
    };
}

// Recompute formula cells through our engine once at import so the persisted
// snapshot carries engine-verified v/m, and report which case happened: only a
// successful recalc may be encoded as `computed`, which is what seeds the decoded
// calcChain and keeps the read-path gate from firing for imported docs. The
// importer's cached values are usually Excel's own, so this mainly reconciles
// divergence; a recalc failure must not block the import, so the parsed sheets go
// in uncomputed and an export recalcs them, under the same budget. recalcSheets syncs the computed values
// into `celldata`, and the encoder drops the dense `data` matrix it also returns.
function recalcImportedSheets(sheets: Sheet[], warnings: TransformWarning[]): { sheets: Sheet[]; computed: boolean } {
    try {
        return { sheets: recalcSheets(sheets, SERVER_RECALC_BUDGET), computed: true };
    } catch (err) {
        warnings.push({ code: 'recalc-failed', message: err instanceof Error ? err.message : String(err) });
        return { sheets, computed: false };
    }
}
