import type * as Y from 'yjs';
import { mediaNamesIn, toDataUriMap } from '../../document/media';
import { readSheetsFromDoc } from '../../document/sheets';
import {
    type ExportMediaLoader,
    htmlExportMode,
    type SheetExportFormat,
    type TransformWarning,
    toTransferableBuffer,
    toTransferableText,
} from '../../document/transform/protocol';
import { withSvgFallbacks } from '../office-image';

// Materialized doc → export bytes. Runs inside the transform process (child.ts owns
// execution; the format logic stays here in export/, pure over Sheet[] + title).
// Per-format renderers load lazily so an HTML export never evaluates the xlsx writer.
// Recalc failure serves replayed values with a warning — an export must never fail
// because recalc hiccuped. Floating images embed as data: URIs, and go into an xlsx as the Office media prep made them,
// an SVG beside its PNG.
export async function renderEigensheetsExport(
    doc: Y.Doc,
    format: SheetExportFormat,
    title: string,
    loadMedia: ExportMediaLoader,
): Promise<{ data: ArrayBuffer; warnings: TransformWarning[] }> {
    const warnings: TransformWarning[] = [];
    const { sheets, recalcError } = readSheetsFromDoc(doc);
    if (recalcError) warnings.push({ code: 'recalc-failed', message: recalcError });

    switch (format) {
        case 'html':
        case 'pdf-html': {
            const { sheetsHtmlDocument } = await import('./render');
            const media = await loadMedia(mediaNamesIn(sheets.map((sheet) => sheet.images)));
            const html = sheetsHtmlDocument({
                title,
                sheets,
                mediaUrls: toDataUriMap(media),
                mode: htmlExportMode(format),
            });
            return { data: toTransferableText(html), warnings };
        }
        case 'xlsx': {
            const { writeXlsx } = await import('./xlsx/to-xlsx');
            const media = await withSvgFallbacks(await loadMedia(mediaNamesIn(sheets.map((sheet) => sheet.images))));
            return { data: toTransferableBuffer(writeXlsx(sheets, { title, media, warnings })), warnings };
        }
    }
}
