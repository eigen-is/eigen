import { encodeSheetsSnapshot, type Sheet } from '@workspace/lib/sheets';
import { recalcSheets } from '@workspace/sheet/engine';
import { ApiError } from '../../core/errors';
import { type TransformWarning, toTransferableText } from '../../document/transform/protocol';
import { xlsxToSheets } from './from-xlsx';

// Uploaded xlsx bytes → the lean snapshot JSON the main thread commits. Runs
// inside the transform Worker (worker.ts owns execution; the conversion logic
// stays here in import/, pure over the buffer). The zip/cell guards ride along
// inside xlsxToSheets with their exact 413s, and a recalc failure comes back as a
// warning — an import must never fail because recalc hiccuped.
export async function importXlsxToSheetsSnapshot(
    data: ArrayBuffer,
): Promise<{ snapshotJson: ArrayBuffer; warnings: TransformWarning[] }> {
    const warnings: TransformWarning[] = [];
    const parsed = await parseXlsxOrThrow(Buffer.from(data));
    const { sheets, computed } = recalcImportedSheets(parsed, warnings);
    return { snapshotJson: toTransferableText(encodeSheetsSnapshot(sheets, { computed })), warnings };
}

async function parseXlsxOrThrow(buffer: Buffer): Promise<Sheet[]> {
    try {
        return await xlsxToSheets(buffer);
    } catch (err) {
        if (err instanceof ApiError) throw err;
        throw new ApiError(400, 'Not a valid xlsx file');
    }
}

// Recompute formula cells through our engine once at import so the persisted
// snapshot carries engine-verified v/m, and report which case happened: only a
// successful recalc may be encoded as `computed`, which is what seeds the decoded
// calcChain and keeps the read-path gate from firing for imported docs. The
// importer's cached values are usually Excel's own, so this mainly reconciles
// divergence; a recalc failure must not block the import, so the parsed sheets go
// in uncomputed and an export recalcs them. recalcSheets syncs the computed values
// into `celldata`, and the encoder drops the dense `data` matrix it also returns.
function recalcImportedSheets(sheets: Sheet[], warnings: TransformWarning[]): { sheets: Sheet[]; computed: boolean } {
    try {
        return { sheets: recalcSheets(sheets), computed: true };
    } catch (err) {
        warnings.push({ code: 'recalc-failed', message: err instanceof Error ? err.message : String(err) });
        return { sheets, computed: false };
    }
}
