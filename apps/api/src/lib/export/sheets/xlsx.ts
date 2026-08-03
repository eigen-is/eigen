import { type DrivePath, stripEigenExtension } from '@workspace/lib/types/drive';
import type { Mount } from '../../mount';
import type { ExportResult } from '../export-document';
import { runEigensheetsExport } from './html';

export async function exportSheetsToXlsx(
    mount: Mount,
    drivePath: DrivePath,
    signal?: AbortSignal,
): Promise<ExportResult> {
    return {
        // The Worker builds the workbook with ExcelJS and transfers the zip bytes,
        // so nothing heavy happens on this thread.
        data: await runEigensheetsExport(mount, drivePath, 'xlsx', signal),
        contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        fileName: `${stripEigenExtension(drivePath.name)}.xlsx`,
    };
}
