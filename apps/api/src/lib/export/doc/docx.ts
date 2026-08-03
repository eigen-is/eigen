import { type DrivePath, stripEigenExtension } from '@workspace/lib/types/drive';
import type { Mount } from '../../mount';
import type { ExportResult } from '../export-document';
import { runEigendocExport } from './html';

export async function exportEigendocToDocx(
    mount: Mount,
    drivePath: DrivePath,
    signal?: AbortSignal,
): Promise<ExportResult> {
    return {
        // The Worker renders the same document the HTML download serves and runs the
        // Turbodocx conversion on it, so nothing heavy happens on this thread.
        data: await runEigendocExport(mount, drivePath, 'docx', signal),
        contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        fileName: `${stripEigenExtension(drivePath.name)}.docx`,
    };
}
