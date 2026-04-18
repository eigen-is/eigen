import { DRIVE_MIME_SHEETS, type DrivePath } from '@workspace/lib/types/drive';
import { ApiError } from '../core';
import type { Drive } from '../drive';
import type { Mount } from '../mount';
import { xlsxToSheets } from './sheets/from-xlsx';
import { writeSheetsToDoc } from './sheets/writer';

export async function convertToDocument(
    drive: Drive,
    mount: Mount,
    sourcePath: DrivePath,
    targetType: string,
): Promise<DrivePath> {
    if (targetType !== 'eigensheets') {
        throw new ApiError(400, `Conversion to "${targetType}" is not supported`);
    }
    if (!sourcePath.name.toLowerCase().endsWith('.xlsx')) {
        throw new ApiError(400, 'Only .xlsx files can be converted to sheets');
    }

    const file = await mount.readFile(sourcePath.id);
    if (!file) throw new ApiError(404, 'File not found');
    const buffer = Buffer.from(await file.arrayBuffer());
    const sheets = await xlsxToSheets(buffer);

    if (!sourcePath.parentId) throw new ApiError(400, 'Cannot convert a root file');
    const name = sourcePath.name.replace(/\.xlsx$/i, '');
    const newPath = await drive.createSheets(sourcePath.mountId, sourcePath.parentId, name);

    const collabDoc = await drive.getCollabDocument(sourcePath.mountId, newPath.id);
    writeSheetsToDoc(collabDoc.doc, sheets);
    return newPath;
}

export async function importIntoDocument(drive: Drive, path: DrivePath, buffer: Buffer): Promise<void> {
    if (path.mimeType !== DRIVE_MIME_SHEETS) {
        throw new ApiError(400, `Import into ${path.mimeType} is not supported`);
    }
    const sheets = await xlsxToSheets(buffer);
    const collabDoc = await drive.getCollabDocument(path.mountId, path.id);
    writeSheetsToDoc(collabDoc.doc, sheets);
}
