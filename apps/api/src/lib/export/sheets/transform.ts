// A spreadsheet's export inside the transform process: the HTML download, the document WeasyPrint prints, and the
// xlsx. Each returns its bytes and the warnings that count what it left out.

import type * as Y from 'yjs';
import { mediaNamesIn, toDataUriMap } from '../../document/media';
import { readSheetsFromDoc } from '../../document/sheets';
import type { ExportMediaLoader, SheetExportFormat, TransformWarning } from '../../document/transform/protocol';
import {
    htmlExportMode,
    lossCounter,
    toTransferableBuffer,
    toTransferableText,
} from '../../document/transform/protocol';
import { withSvgFallbacks } from '../office-image';

// The writers load lazily, so an HTML export never evaluates the xlsx writer. A failed recalc exports the replayed
// values with a warning, as an export never fails for it. Images embed as data: URIs in the HTML, and go into an xlsx
// as the Office media prep made them, an SVG beside its PNG.
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
            const losses = lossCounter();
            const html = sheetsHtmlDocument({
                title,
                sheets,
                mediaUrls: toDataUriMap(media),
                mode: htmlExportMode(format),
                lost: losses.lost,
            });
            return { data: toTransferableText(html), warnings: [...warnings, ...losses.warnings()] };
        }
        case 'xlsx': {
            const { writeXlsx } = await import('./xlsx/to-xlsx');
            const media = await withSvgFallbacks(await loadMedia(mediaNamesIn(sheets.map((sheet) => sheet.images))));
            const losses = lossCounter();
            const xlsx = writeXlsx(sheets, { title, media, lost: losses.lost });
            return { data: toTransferableBuffer(xlsx), warnings: [...warnings, ...losses.warnings()] };
        }
    }
}
