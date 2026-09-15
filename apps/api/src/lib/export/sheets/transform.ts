import type * as Y from 'yjs';
import { toDataUriMap } from '../../document/media';
import { readSheetsFromDoc } from '../../document/sheets';
import {
    type SheetExportFormat,
    type TransformMedia,
    type TransformWarning,
    toTransferableBuffer,
    toTransferableText,
} from '../../document/transform/protocol';

// Materialized doc → export bytes. Runs inside the transform Worker (worker.ts owns
// execution; the format logic stays here in export/, pure over Sheet[] + title).
// Per-format renderers load lazily so an HTML export never evaluates ExcelJS.
// Recalc failure serves replayed values with a warning — an export must never fail
// because recalc hiccuped. Floating images embed as data: URIs; xlsx ignores them —
// ExcelJS has no writer this exporter uses for a floating picture.
export async function renderEigensheetsExport(
    doc: Y.Doc,
    format: SheetExportFormat,
    title: string,
    media: TransformMedia[],
): Promise<{ data: ArrayBuffer; warnings: TransformWarning[] }> {
    const warnings: TransformWarning[] = [];
    const { sheets, recalcError } = readSheetsFromDoc(doc);
    if (recalcError) warnings.push({ code: 'recalc-failed', message: recalcError });

    switch (format) {
        case 'html': {
            const { renderSheetsExportDocument } = await import('./render');
            return {
                data: toTransferableText(renderSheetsExportDocument(sheets, title, toDataUriMap(media))),
                warnings,
            };
        }
        case 'pdf-html': {
            const { renderSheetsPdfDocument } = await import('./render');
            return { data: toTransferableText(renderSheetsPdfDocument(sheets, title, toDataUriMap(media))), warnings };
        }
        case 'xlsx': {
            const { sheetsToXlsx } = await import('./to-xlsx');
            return { data: toTransferableBuffer(await sheetsToXlsx(sheets)), warnings };
        }
    }
}
