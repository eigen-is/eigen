import type { DrivePath } from '@workspace/lib/types/drive';
import type { Mount } from '../../mount';
import type { ExportResult } from '../export-document';
import { htmlToPdf } from '../weasyprint';
import { generateSheetsExportHtml } from './html';

export async function exportSheetsToPdf(mount: Mount, drivePath: DrivePath): Promise<ExportResult> {
    const html = await generateSheetsExportHtml(mount, drivePath);
    const title = drivePath.name.replace(/\.eigensheets$/, '');

    return {
        data: await htmlToPdf(html),
        contentType: 'application/pdf',
        fileName: `${title}.pdf`,
    };
}
