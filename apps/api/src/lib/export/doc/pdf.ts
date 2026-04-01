import type { DrivePath } from '@workspace/lib/types/drive';
import type { Mount } from '../../mount';
import { htmlToPdf } from '../weasyprint';
import { generateExportHtml } from './html';
import { type ExportResult, stripEigendocExtension } from './render';

export async function exportEigendocToPdf(mount: Mount, drivePath: DrivePath): Promise<ExportResult> {
    const html = await generateExportHtml(mount, drivePath);
    const title = stripEigendocExtension(drivePath.name);

    return {
        data: await htmlToPdf(html),
        contentType: 'application/pdf',
        fileName: `${title}.pdf`,
    };
}
