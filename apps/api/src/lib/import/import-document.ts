import { DRIVE_MIME_DOC, DRIVE_MIME_SHEETS, type DrivePath } from '@workspace/lib/types/drive';
import { ApiError } from '../core';
import { writeEigendocToYjs } from '../document/doc';
import { writeSheetsSnapshotToYjs } from '../document/sheets';
import { type ImportTransformJob, toTransferableBuffer } from '../document/transform/protocol';
import { runImportToSnapshotJson } from '../document/transform/run-transform';
import { EXPORT_IMPORT_TRANSFORM_DEADLINE_MS } from '../document/transform/runner';
import type { Drive, SharedDrive } from '../drive';
import type { Mount } from '../mount';
import type { User } from '../user';
import type { DocxImage } from './doc/from-docx';

const XLSX_TO_SHEETS: ImportTransformJob = { kind: 'import', sourceFormat: 'xlsx', targetType: 'eigensheets' };

// Parsing, guards, recalc and serialization run in the transform Worker; the main
// thread only commits the returned snapshot. Nothing is created or mutated before
// the Worker succeeds, so a failed import leaves source and target untouched.
// The upload Buffer can be a view over a larger pool, and a transfer hands over
// the WHOLE backing buffer — copy into an exact standalone one first.
function importXlsxSnapshot(buffer: Buffer, signal?: AbortSignal): Promise<string> {
    return runImportToSnapshotJson(XLSX_TO_SHEETS, toTransferableBuffer(buffer), {
        deadlineMs: EXPORT_IMPORT_TRANSFORM_DEADLINE_MS,
        signal,
    });
}

// docx is a zip-based format — the parser needs the full file in memory to read
// the central directory and extract parts. Callers are expected to size-check first.
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
    user?: User,
    signal?: AbortSignal,
): Promise<DrivePath> {
    if (!sourcePath.parentId) throw new ApiError(400, 'Cannot convert a root file');

    const file = await mount.readFile(sourcePath.id);
    if (!file) throw new ApiError(404, 'File not found');
    const buffer = Buffer.from(await file.arrayBuffer());

    if (targetType === 'eigensheets') {
        if (!sourcePath.name.toLowerCase().endsWith('.xlsx')) {
            throw new ApiError(400, 'Only .xlsx files can be converted to sheets');
        }
        const snapshotJson = await importXlsxSnapshot(buffer, signal);
        const name = sourcePath.name.replace(/\.xlsx$/i, '');
        const newPath = await drive.create(sourcePath.mountId, sourcePath.parentId, name, 'sheets', user);
        const collabDoc = await drive.getCollabDocument(sourcePath.mountId, newPath.id);
        writeSheetsSnapshotToYjs(collabDoc.doc, snapshotJson);
        return newPath;
    }

    if (targetType === 'eigendoc') {
        if (!sourcePath.name.toLowerCase().endsWith('.docx')) {
            throw new ApiError(400, 'Only .docx files can be converted to documents');
        }
        const { json, images, schema } = await parseDocxOrThrow(buffer);
        const name = sourcePath.name.replace(/\.docx$/i, '');
        const newPath = await drive.create(sourcePath.mountId, sourcePath.parentId, name, 'doc', user);
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
    signal?: AbortSignal,
): Promise<void> {
    if (path.mimeType === DRIVE_MIME_SHEETS) {
        const snapshotJson = await importXlsxSnapshot(buffer, signal);
        const collabDoc = await drive.getCollabDocument(path.mountId, path.id);
        writeSheetsSnapshotToYjs(collabDoc.doc, snapshotJson);
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
