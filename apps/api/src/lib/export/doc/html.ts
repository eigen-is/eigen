import { type DrivePath, stripEigenExtension } from '@workspace/lib/types/drive';
import type { EigendocExportFormat } from '../../document/transform/protocol';
import { runTransformToBytes } from '../../document/transform/run-transform';
import { EXPORT_IMPORT_TRANSFORM_DEADLINE_MS } from '../../document/transform/runner';
import type { Mount } from '../../mount';
import type { ExportResult } from '../export-document';
import { collectExportMedia } from '../media';

// Main-thread wrapper for every eigendoc export: prepare the media (Mount I/O and
// screen previews stay here), then run the one shared transform seam. The Worker
// returns the export bytes — the UTF-8 document for html (served as-is) and pdf-html
// (decoded by WeasyPrint), the zip for docx. The <title> keeps the UNstripped
// container name (frozen output).
export async function runEigendocExport(
    mount: Mount,
    drivePath: DrivePath,
    format: EigendocExportFormat,
    signal?: AbortSignal,
): Promise<Buffer> {
    const prepStart = performance.now();
    const media = await collectExportMedia(mount, drivePath);
    const job = { kind: 'export', documentType: 'eigendoc', format, title: drivePath.name, media } as const;
    return runTransformToBytes(mount, drivePath, job, {
        deadlineMs: EXPORT_IMPORT_TRANSFORM_DEADLINE_MS,
        prepMs: performance.now() - prepStart,
        signal,
    });
}

export async function exportEigendocToHtml(
    mount: Mount,
    drivePath: DrivePath,
    signal?: AbortSignal,
): Promise<ExportResult> {
    return {
        data: await runEigendocExport(mount, drivePath, 'html', signal),
        contentType: 'text/html; charset=utf-8',
        fileName: `${stripEigenExtension(drivePath.name)}.html`,
    };
}
