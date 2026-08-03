import { type DrivePath, stripEigenExtension } from '@workspace/lib/types/drive';
import type { SheetExportFormat } from '../../document/transform/protocol';
import { runTransformToBytes } from '../../document/transform/run-transform';
import { EXPORT_IMPORT_TRANSFORM_DEADLINE_MS } from '../../document/transform/runner';
import type { Mount } from '../../mount';
import type { ExportResult } from '../export-document';

// Main-thread wrapper for every eigensheets export: run the one shared transform
// seam. The Worker returns the export bytes — the UTF-8 document for html (served
// as-is) and pdf-html (decoded by WeasyPrint), the workbook zip for xlsx.
export async function runEigensheetsExport(
    mount: Mount,
    drivePath: DrivePath,
    format: SheetExportFormat,
    signal?: AbortSignal,
): Promise<Buffer> {
    const job = {
        kind: 'export',
        documentType: 'eigensheets',
        format,
        title: stripEigenExtension(drivePath.name),
    } as const;
    return runTransformToBytes(mount, drivePath, job, {
        deadlineMs: EXPORT_IMPORT_TRANSFORM_DEADLINE_MS,
        signal,
    });
}

export async function exportSheetsToHtml(
    mount: Mount,
    drivePath: DrivePath,
    signal?: AbortSignal,
): Promise<ExportResult> {
    return {
        data: await runEigensheetsExport(mount, drivePath, 'html', signal),
        contentType: 'text/html; charset=utf-8',
        fileName: `${stripEigenExtension(drivePath.name)}.html`,
    };
}
