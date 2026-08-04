import type { Sheet } from '@workspace/lib/sheets';
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
    const sheets = recalcImportedSheets(parsed, warnings);
    return { snapshotJson: toTransferableText(JSON.stringify(sheets)), warnings };
}

// xlsx is a zip-based format — the parser needs the full file in memory to read
// the central directory and extract parts. Callers size-check before this point.
async function parseXlsxOrThrow(buffer: Buffer): Promise<Sheet[]> {
    try {
        return await xlsxToSheets(buffer);
    } catch (err) {
        if (err instanceof ApiError) throw err;
        throw new ApiError(400, 'Not a valid xlsx file');
    }
}

// Recompute formula cells through our engine once at import so the persisted
// snapshot carries engine-verified v/m (and a calcChain, so the read-path gate
// never fires for imported docs). The importer's cached values are usually
// Excel's own, so this mainly reconciles divergence; a recalc failure must not
// block the import, so fall back to the parsed sheets. recalcSheets returns a
// dense `data` matrix, but the importer persists sparse `celldata` only (the
// computed values are synced into it) — drop `data` so a large import doesn't
// bloat the snapshot; the read path re-materializes it.
function recalcImportedSheets(sheets: Sheet[], warnings: TransformWarning[]): Sheet[] {
    try {
        return recalcSheets(sheets).map((sheet) => {
            const lean = { ...sheet };
            delete lean.data;
            return lean;
        });
    } catch (err) {
        warnings.push({ code: 'recalc-failed', message: err instanceof Error ? err.message : String(err) });
        return sheets;
    }
}
