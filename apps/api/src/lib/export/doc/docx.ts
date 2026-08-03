/// <reference path="../modules.d.ts" />
import { type DrivePath, stripEigenExtension } from '@workspace/lib/types/drive';
import type { Mount } from '../../mount';
import type { ExportResult } from '../export-document';
import { runEigendocExport } from './html';

export async function exportEigendocToDocx(
    mount: Mount,
    drivePath: DrivePath,
    signal?: AbortSignal,
): Promise<ExportResult> {
    // The same document the HTML download serves; the DOCX conversion itself still
    // runs on the main thread (it moves into the Worker with the DOCX phase).
    const html = (await runEigendocExport(mount, drivePath, 'html', signal)).toString('utf-8');
    const title = stripEigenExtension(drivePath.name);

    const HTMLtoDOCX = (await import('@turbodocx/html-to-docx')).default;
    const docxBuffer = await HTMLtoDOCX(html, undefined, {
        title,
        margins: { top: 1440, right: 1440, bottom: 1440, left: 1440 },
    });

    return {
        data: Buffer.from(docxBuffer as ArrayBuffer),
        contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        fileName: `${title}.docx`,
    };
}
