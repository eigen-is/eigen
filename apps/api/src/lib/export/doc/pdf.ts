import { type DrivePath, stripEigenExtension } from '@workspace/lib/types/drive';
import type { Mount } from '../../mount';
import type { ExportResult } from '../export-document';
import { htmlToPdf } from '../weasyprint';
import { runEigendocExport } from './html';

export async function exportEigendocToPdf(
    mount: Mount,
    drivePath: DrivePath,
    signal?: AbortSignal,
): Promise<ExportResult> {
    // The Worker returns the wrapped HTML; WeasyPrint stays a main-thread subprocess
    // (already off-process, so it never blocks the event loop).
    const bytes = await runEigendocExport(mount, drivePath, 'pdf-html', signal);

    return {
        data: await htmlToPdf(bytes.toString('utf-8')),
        contentType: 'application/pdf',
        fileName: `${stripEigenExtension(drivePath.name)}.pdf`,
    };
}
