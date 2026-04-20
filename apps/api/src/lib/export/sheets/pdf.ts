import type { DrivePath } from '@workspace/lib/types/drive';
import DOMPurify from 'isomorphic-dompurify';
import type { Mount } from '../../mount';
import type { ExportResult } from '../export-document';
import { htmlToPdf } from '../weasyprint';
import { loadSheetsContent } from './content';
import { getSheetContentSize, renderSheetsHtml, wrapInDocument } from './html';

const PAGE_MARGIN = 40;

export async function exportSheetsToPdf(mount: Mount, drivePath: DrivePath): Promise<ExportResult> {
    const title = drivePath.name.replace(/\.eigensheets$/, '');
    const sheets = await loadSheetsContent(mount, drivePath);

    let maxW = 0;
    let maxH = 0;
    for (const sheet of sheets) {
        const size = getSheetContentSize(sheet);
        if (size.width > maxW) maxW = size.width;
        if (size.height > maxH) maxH = size.height;
    }

    const bodyHtml = renderSheetsHtml(sheets);
    const sanitized = DOMPurify.sanitize(bodyHtml, { FORCE_BODY: true });
    const pageSize = {
        width: maxW + 2 * PAGE_MARGIN,
        height: maxH + 2 * PAGE_MARGIN,
    };
    const html = wrapInDocument(title, sanitized, pageSize);

    return {
        data: await htmlToPdf(html),
        contentType: 'application/pdf',
        fileName: `${title}.pdf`,
    };
}
