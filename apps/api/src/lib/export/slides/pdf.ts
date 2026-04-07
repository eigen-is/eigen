import type { DrivePath } from '@workspace/lib/types/drive';
import type { Mount } from '../../mount';
import type { ExportResult } from '../export-document';
import { htmlToPdf } from '../weasyprint';
import { generateSlidesExportHtml } from './html';
import { stripSlidesExtension } from './render';

export async function exportSlidesToPdf(mount: Mount, drivePath: DrivePath): Promise<ExportResult> {
    const html = await generateSlidesExportHtml(mount, drivePath, 'pdf');
    const title = stripSlidesExtension(drivePath.name);

    return {
        data: await htmlToPdf(html),
        contentType: 'application/pdf',
        fileName: `${title}.pdf`,
    };
}
