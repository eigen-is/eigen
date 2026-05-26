import { type DrivePath, stripEigenExtension } from '@workspace/lib/types/drive';
import type { Mount } from '../../mount';
import type { ExportResult } from '../export-document';
import { htmlToPdf } from '../weasyprint';
import { generateExportHtml } from './html';

export async function exportEigendocToPdf(mount: Mount, drivePath: DrivePath): Promise<ExportResult> {
    const html = await generateExportHtml(mount, drivePath);
    const title = stripEigenExtension(drivePath.name);

    return {
        data: await htmlToPdf(html),
        contentType: 'application/pdf',
        fileName: `${title}.pdf`,
    };
}
