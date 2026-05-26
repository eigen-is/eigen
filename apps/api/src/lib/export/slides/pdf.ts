import { type DrivePath, stripEigenExtension } from '@workspace/lib/types/drive';
import type { Mount } from '../../mount';
import type { ExportResult } from '../export-document';
import { htmlToPdf } from '../weasyprint';
import { generateSlidesExportHtml } from './html';

export async function exportSlidesToPdf(mount: Mount, drivePath: DrivePath): Promise<ExportResult> {
    const html = await generateSlidesExportHtml(mount, drivePath, 'pdf');
    const title = stripEigenExtension(drivePath.name);

    return {
        data: await htmlToPdf(html),
        contentType: 'application/pdf',
        fileName: `${title}.pdf`,
    };
}
