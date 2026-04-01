/// <reference path="../modules.d.ts" />
import type { DrivePath } from '@workspace/lib/types/drive';
import type { Mount } from '../../mount';
import { generateExportHtml } from './html';
import { type ExportResult, stripEigendocExtension } from './render';

export async function exportEigendocToDocx(mount: Mount, drivePath: DrivePath): Promise<ExportResult> {
    const html = await generateExportHtml(mount, drivePath);
    const title = stripEigendocExtension(drivePath.name);

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
