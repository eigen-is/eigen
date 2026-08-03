import type * as Y from 'yjs';
import { readSheetsFromDoc } from '../../document/sheets';
import { type SheetExportFormat, type TransformWarning, toTransferableBuffer } from '../../document/transform/protocol';

// Materialized doc → export bytes. Runs inside the transform Worker (worker.ts owns
// execution; the format logic stays here in export/, pure over Sheet[] + title).
// Per-format renderers load lazily so an HTML export never evaluates ExcelJS.
// Recalc failure serves replayed values with a warning — an export must never fail
// because recalc hiccuped.
export async function renderEigensheetsExport(
    doc: Y.Doc,
    format: SheetExportFormat,
    title: string,
): Promise<{ data: ArrayBuffer; warnings: TransformWarning[] }> {
    const warnings: TransformWarning[] = [];
    const { sheets, recalcError } = readSheetsFromDoc(doc);
    if (recalcError) warnings.push({ code: 'recalc-failed', message: recalcError });

    switch (format) {
        case 'html': {
            const { renderSheetsExportDocument } = await import('./html');
            return { data: encodeDocument(renderSheetsExportDocument(sheets, title)), warnings };
        }
        case 'pdf-html': {
            const { renderSheetsPdfDocument } = await import('./pdf');
            return { data: encodeDocument(renderSheetsPdfDocument(sheets, title)), warnings };
        }
        case 'xlsx': {
            const { sheetsToXlsx } = await import('./xlsx');
            return { data: toTransferableBuffer(await sheetsToXlsx(sheets)), warnings };
        }
    }
}

function encodeDocument(html: string): ArrayBuffer {
    return toTransferableBuffer(new TextEncoder().encode(html));
}
