import { type DrivePath, stripEigenExtension } from '@workspace/lib/types/drive';
import type { Mount } from '../../mount';
import type { ExportResult } from '../export-document';
import { htmlToPdf } from '../weasyprint';
import { runSlidesExport } from './html';

export async function exportSlidesToPdf(
    mount: Mount,
    drivePath: DrivePath,
    signal?: AbortSignal,
): Promise<ExportResult> {
    // The Worker returns the fixed-size HTML; WeasyPrint stays a main-thread
    // subprocess (already off-process, so it never blocks the event loop).
    const bytes = await runSlidesExport(mount, drivePath, 'pdf-html', signal);

    return {
        data: await htmlToPdf(bytes.toString('utf-8')),
        contentType: 'application/pdf',
        fileName: `${stripEigenExtension(drivePath.name)}.pdf`,
    };
}
