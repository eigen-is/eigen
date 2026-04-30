import type { Sheet } from '@workspace/lib/sheets';
import { DRIVE_MIME_DOC, DRIVE_MIME_SHEETS, type DrivePath } from '@workspace/lib/types/drive';
import { ApiError } from '../core';
import { writeEigendocToYjs } from '../document/doc';
import { writeSheetsToYjs } from '../document/sheets';
import type { Drive, SharedDrive } from '../drive';
import type { Mount } from '../mount';
import type { DocxImage } from './doc/from-docx';
import { xlsxToSheets } from './sheets/from-xlsx';

// xlsx and docx are zip-based formats — the parsers need the full file in memory to read
// the central directory and extract parts. Callers are expected to size-check before passing.
async function parseXlsxOrThrow(buffer: Buffer): Promise<Sheet[]> {
    try {
        return await xlsxToSheets(buffer);
    } catch (err) {
        if (err instanceof ApiError) throw err;
        throw new ApiError(400, 'Not a valid xlsx file');
    }
}

async function parseDocxOrThrow(buffer: Buffer) {
    try {
        const { docxToPmJson, docSchema } = await import('./doc/from-docx');
        const result = await docxToPmJson(buffer);
        return { ...result, schema: docSchema };
    } catch (err) {
        if (err instanceof ApiError) throw err;
        throw new ApiError(400, 'Not a valid docx file');
    }
}

async function saveDocImages(mount: Mount, docPath: DrivePath, images: DocxImage[]): Promise<void> {
    if (images.length === 0) return;
    const mediaFolder = await mount.getChildByName(docPath.id, 'media');
    if (!mediaFolder) throw new ApiError(500, 'Document media folder not found');
    for (const image of images) {
        await mount.createFile(mediaFolder.id, image.name, image.contentType, image.data.byteLength, image.data);
    }
}

export async function convertToDocument(
    drive: Drive | SharedDrive,
    mount: Mount,
    sourcePath: DrivePath,
    targetType: 'eigensheets' | 'eigendoc',
): Promise<DrivePath> {
    if (!sourcePath.parentId) throw new ApiError(400, 'Cannot convert a root file');

    const file = await mount.readFile(sourcePath.id);
    if (!file) throw new ApiError(404, 'File not found');
    const buffer = Buffer.from(await file.arrayBuffer());

    if (targetType === 'eigensheets') {
        if (!sourcePath.name.toLowerCase().endsWith('.xlsx')) {
            throw new ApiError(400, 'Only .xlsx files can be converted to sheets');
        }
        const sheets = await parseXlsxOrThrow(buffer);
        const name = sourcePath.name.replace(/\.xlsx$/i, '');
        const newPath = await drive.create(sourcePath.mountId, sourcePath.parentId, name, 'sheets');
        const collabDoc = await drive.getCollabDocument(sourcePath.mountId, newPath.id);
        writeSheetsToYjs(collabDoc.doc, sheets);
        return newPath;
    }

    if (targetType === 'eigendoc') {
        if (!sourcePath.name.toLowerCase().endsWith('.docx')) {
            throw new ApiError(400, 'Only .docx files can be converted to documents');
        }
        const { json, images, schema } = await parseDocxOrThrow(buffer);
        const name = sourcePath.name.replace(/\.docx$/i, '');
        const newPath = await drive.create(sourcePath.mountId, sourcePath.parentId, name, 'doc');
        const collabDoc = await drive.getCollabDocument(sourcePath.mountId, newPath.id);
        writeEigendocToYjs(collabDoc.doc, json, schema);
        await saveDocImages(mount, newPath, images);
        return newPath;
    }

    throw new ApiError(400, `Conversion to "${targetType}" is not supported`);
}

export async function importIntoDocument(
    drive: Drive | SharedDrive,
    mount: Mount,
    path: DrivePath,
    buffer: Buffer,
): Promise<void> {
    if (path.mimeType === DRIVE_MIME_SHEETS) {
        const sheets = await parseXlsxOrThrow(buffer);
        const collabDoc = await drive.getCollabDocument(path.mountId, path.id);
        writeSheetsToYjs(collabDoc.doc, sheets);
        return;
    }

    if (path.mimeType === DRIVE_MIME_DOC) {
        const { json, images, schema } = await parseDocxOrThrow(buffer);
        const collabDoc = await drive.getCollabDocument(path.mountId, path.id);
        writeEigendocToYjs(collabDoc.doc, json, schema);
        await saveDocImages(mount, path, images);
        return;
    }

    throw new ApiError(400, `Import into ${path.mimeType} is not supported`);
}
