import { type DrivePath, stripEigenExtension } from '@workspace/lib/types/drive';
import DOMPurify from 'isomorphic-dompurify';
import { readSheetsContent } from '../../document/sheets';
import type { Mount } from '../../mount';
import type { ExportResult } from '../export-document';
import { htmlToPdf } from '../weasyprint';
import { getSheetContentSize, renderSheetsHtml, wrapInDocument } from './html';

const PAGE_MARGIN = 40;
const PAGE_SLACK = 20;

export async function exportSheetsToPdf(mount: Mount, drivePath: DrivePath): Promise<ExportResult> {
    const title = stripEigenExtension(drivePath.name);
    const sheets = await readSheetsContent(mount, drivePath);

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
        width: maxW + 2 * PAGE_MARGIN + PAGE_SLACK,
        height: maxH + 2 * PAGE_MARGIN + PAGE_SLACK,
    };
    const html = wrapInDocument(title, sanitized, pageSize);

    return {
        data: await htmlToPdf(html),
        contentType: 'application/pdf',
        fileName: `${title}.pdf`,
    };
}
