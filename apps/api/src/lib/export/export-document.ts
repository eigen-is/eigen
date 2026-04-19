import { DRIVE_MIME_DOC, DRIVE_MIME_SHEETS, DRIVE_MIME_SLIDES } from '@workspace/lib/types';
import type { DrivePath } from '@workspace/lib/types/drive';
import { ApiError } from '../core';
import type { Mount } from '../mount';
import { exportEigendocToDocx } from './doc/docx';
import { exportEigendocToHtml } from './doc/html';
import { exportEigendocToPdf } from './doc/pdf';
import { exportSheetsToXlsx } from './sheets/xlsx';
import { exportSlidesToHtml } from './slides/html';
import { exportSlidesToPdf } from './slides/pdf';

export type ExportResult = {
    data: Buffer;
    contentType: string;
    fileName: string;
};

export async function exportDocument(mount: Mount, path: DrivePath, format: string): Promise<ExportResult> {
    if (path.mimeType === DRIVE_MIME_DOC) {
        if (format === 'docx') return exportEigendocToDocx(mount, path);
        if (format === 'pdf') return exportEigendocToPdf(mount, path);
        if (format === 'html') return exportEigendocToHtml(mount, path);
    }
    if (path.mimeType === DRIVE_MIME_SHEETS) {
        if (format === 'xlsx') return exportSheetsToXlsx(mount, path);
    }
    if (path.mimeType === DRIVE_MIME_SLIDES) {
        if (format === 'pdf') return exportSlidesToPdf(mount, path);
        if (format === 'html') return exportSlidesToHtml(mount, path);
    }
    throw new ApiError(400, `Format "${format}" is not supported for ${path.mimeType}`);
}
