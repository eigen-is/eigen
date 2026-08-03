import type { Sheet } from '@workspace/lib/sheets';
import { type DrivePath, stripEigenExtension } from '@workspace/lib/types/drive';
import { runTransformToBytes } from '../../document/transform/run-transform';
import { EXPORT_TRANSFORM_DEADLINE_MS } from '../../document/transform/runner';
import type { Mount } from '../../mount';
import type { ExportResult } from '../export-document';
import { sanitizeExportHtml } from '../sanitize';
import { htmlToPdf } from '../weasyprint';
import { getSheetContentSize, renderSheetsHtml, wrapInDocument } from './html';

const PAGE_MARGIN = 40;
const PAGE_SLACK = 20;

export async function exportSheetsToPdf(
    mount: Mount,
    drivePath: DrivePath,
    signal?: AbortSignal,
): Promise<ExportResult> {
    const title = stripEigenExtension(drivePath.name);
    const job = { kind: 'export', documentType: 'eigensheets', format: 'pdf-html', title } as const;
    // The Worker returns the wrapped HTML; WeasyPrint stays a main-thread
    // subprocess (already off-process, so it never blocks the event loop).
    const bytes = await runTransformToBytes(mount, drivePath, job, {
        deadlineMs: EXPORT_TRANSFORM_DEADLINE_MS,
        signal,
    });
    const html = bytes.toString('utf-8');

    return {
        data: await htmlToPdf(html),
        contentType: 'application/pdf',
        fileName: `${title}.pdf`,
    };
}

// Runs inside the transform Worker. The page is sized to the widest/tallest sheet
// so WeasyPrint never clips a wide grid. Unlike the HTML export this sanitizes
// with no options — no `target` on anchors in a PDF.
export function renderSheetsPdfDocument(sheets: Sheet[], title: string): string {
    let maxW = 0;
    let maxH = 0;
    for (const sheet of sheets) {
        const size = getSheetContentSize(sheet);
        if (size.width > maxW) maxW = size.width;
        if (size.height > maxH) maxH = size.height;
    }

    const sanitized = sanitizeExportHtml(renderSheetsHtml(sheets));
    const pageSize = {
        width: maxW + 2 * PAGE_MARGIN + PAGE_SLACK,
        height: maxH + 2 * PAGE_MARGIN + PAGE_SLACK,
    };
    return wrapInDocument(title, sanitized, pageSize);
}
