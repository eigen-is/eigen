import {
    type ConvertTarget,
    DRIVE_MIME_DOC,
    DRIVE_MIME_SHEETS,
    DRIVE_TYPE_FILE,
    type DrivePath,
    isCollabType,
} from '@workspace/lib/types/drive';
import { enforceMountQuota } from '../config/enforcement';
import { getPublicOrigin } from '../config/server-config';
import { ApiError } from '../core/errors';
import { MAX_DECOMPRESSED_BYTES } from '../core/zip';
import { commitEigendocImport } from '../document/doc';
import { writeSheetsSnapshotToYjs } from '../document/sheets';
import {
    type DocImportWorkerResult,
    type ImportTransformJob,
    type SheetsImportJob,
    type TransformMedia,
    toTransferableBuffer,
} from '../document/transform/protocol';
import { runImportToDocumentUpdate, runImportToSnapshotJson } from '../document/transform/run-transform';
import { documentTransformRunner } from '../document/transform/runner';
import type { DriveLike } from '../drive/get-drive';
import type { Mount } from '../mount';
import type { User } from '../user';
import { IMPORT_TOO_LARGE } from './messages';

const XLSX_TO_SHEETS: SheetsImportJob = { kind: 'import', sourceFormat: 'xlsx', targetType: 'eigensheets' };

// Parsing, guards, recalc and serialization run in the transform process; the main
// thread only commits what it returns — the snapshot for sheets, a ready Yjs update
// plus extracted media for documents. Nothing is created or mutated before the transform
// succeeds, so a failed import leaves source and target untouched.
// Refuse before the copy: a view over a larger pool is copied out, and IPC copies the
// upload again, so a job the runner will not admit must not pay for it. run() rechecks
// authoritatively.
function importXlsxSnapshot(buffer: Buffer, signal?: AbortSignal): Promise<string> {
    documentTransformRunner.assertAdmissible('foreground');
    assertWithinByteCap(buffer.byteLength, 'xlsx');
    return runImportToSnapshotJson(XLSX_TO_SHEETS, toTransferableBuffer(buffer), { signal });
}

function importDocxUpdate(buffer: Buffer, signal?: AbortSignal): Promise<DocImportWorkerResult> {
    documentTransformRunner.assertAdmissible('foreground');
    assertWithinByteCap(buffer.byteLength, 'docx');
    return runImportToDocumentUpdate(
        { kind: 'import', sourceFormat: 'docx', targetType: 'eigendoc', publicOrigin: getPublicOrigin() },
        toTransferableBuffer(buffer),
        { signal },
    );
}

// openZip refuses an archive past the byte cap anyway; refused here, a file that large is never read or copied to the
// transform. The upload cap allows up to a gigabyte, and a convert reads a stored file of any size.
function assertWithinByteCap(bytes: number, format: ImportTransformJob['sourceFormat']): void {
    if (bytes > MAX_DECOMPRESSED_BYTES) throw new ApiError(413, IMPORT_TOO_LARGE[format]);
}

// The route checked write before buffering, but the job can queue and transform for
// minutes — long enough for the share to be revoked. `getCollabDocument` re-checks
// read only, so the commit needs its own write check — as the LAST await before the
// synchronous write, or a revocation landing during the lookup still commits.
async function requireWritePermission(drive: DriveLike, path: DrivePath, user: User): Promise<void> {
    if (!(await drive.canWrite(path.mountId, path.id, user))) throw new ApiError(403, 'No write permission');
}

function imagesSize(images: TransformMedia[]): number {
    return images.reduce((sum, image) => sum + image.data.byteLength, 0);
}

// Through Drive, as an upload is: the ACL check, the drive event an open tab redraws on and the thumbnail. The images
// count toward the quota, inflated up to the zip cap, and are charged before the first is written.
async function saveDocImages(
    drive: DriveLike,
    docPath: DrivePath,
    images: TransformMedia[],
    user: User,
): Promise<void> {
    if (images.length === 0) return;
    const mediaFolder = await drive.getChildByName(docPath.mountId, docPath.id, 'media');
    if (!mediaFolder) throw new ApiError(500, 'Document media folder not found');
    // Extracted names are deterministic (image-1.png, …), so a repeat import overwrites its files in place, credited their
    // size: a create would rename the collision to one the update doesn't name. Names the new import doesn't produce stay.
    const existing = await Promise.all(
        images.map((image) => drive.getChildByName(docPath.mountId, mediaFolder.id, image.name)),
    );
    // Anything else under that name is neither written over nor credited, and a create would rename the image away
    // from the name the document gives it.
    const blocked = existing.find((path) => path && path.type !== DRIVE_TYPE_FILE);
    if (blocked) throw new ApiError(409, `media/${blocked.name} is not a file`);
    const credit = existing.reduce((sum, path) => sum + (path?.size ?? 0), 0);
    await enforceMountQuota(docPath.ownerId, docPath.mountId, imagesSize(images), credit);
    for (const [i, image] of images.entries()) {
        const data = Buffer.from(image.data);
        const path = existing[i];
        if (path) await drive.writeFileContent(docPath.mountId, path.id, data, user);
        else await drive.createFileFromData(docPath.mountId, mediaFolder.id, image.name, image.contentType, data, user);
    }
}

// No signal parameter by design: conversion detaches from the request so a page
// reload cannot kill a minute of transform progress (routes/drive.ts /convert).
export async function convertToDocument(
    drive: DriveLike,
    mount: Mount,
    sourcePath: DrivePath,
    targetType: ConvertTarget,
    user: User,
): Promise<DrivePath> {
    if (!sourcePath.parentId) throw new ApiError(400, 'Cannot convert a root file');

    // Refuse before the stored-file read: buffering the source (possibly an S3 GET)
    // is the costliest preparation here. run() rechecks authoritatively.
    documentTransformRunner.assertAdmissible('foreground');
    const sheets = targetType === 'eigensheets';
    if (sheets && !sourcePath.name.toLowerCase().endsWith('.xlsx')) {
        throw new ApiError(400, 'Only .xlsx files can be converted to sheets');
    }
    if (!sheets && !sourcePath.name.toLowerCase().endsWith('.docx')) {
        throw new ApiError(400, 'Only .docx files can be converted to documents');
    }
    assertWithinByteCap(sourcePath.size, sheets ? 'xlsx' : 'docx');

    const bytes = await mount.readBytes(sourcePath.id);
    if (!bytes) throw new ApiError(404, 'File not found');
    const buffer = Buffer.from(bytes);

    if (sheets) {
        const snapshotJson = await importXlsxSnapshot(buffer);
        const name = sourcePath.name.replace(/\.xlsx$/i, '');
        const newPath = await drive.create(sourcePath.mountId, sourcePath.parentId, name, 'sheets', user);
        const collabDoc = await drive.getCollabDocument(sourcePath.mountId, newPath.id);
        writeSheetsSnapshotToYjs(collabDoc.doc, snapshotJson);
        return newPath;
    }

    const { update, page, style, images } = await importDocxUpdate(buffer);
    // Refused before the create, so no empty document is left behind; saveDocImages charges again as it writes.
    await enforceMountQuota(sourcePath.ownerId, sourcePath.mountId, imagesSize(images));
    const name = sourcePath.name.replace(/\.docx$/i, '');
    const newPath = await drive.create(sourcePath.mountId, sourcePath.parentId, name, 'doc', user);
    const collabDoc = await drive.getCollabDocument(sourcePath.mountId, newPath.id);
    await saveDocImages(drive, newPath, images, user);
    commitEigendocImport(collabDoc.doc, { update: new Uint8Array(update), page, style });
    return newPath;
}

export async function importIntoDocument(
    drive: DriveLike,
    path: DrivePath,
    buffer: Buffer,
    user: User,
    signal?: AbortSignal,
): Promise<void> {
    // The container TYPE gates the dispatch: mimeType is caller-controlled on upload, so a plain
    // file wearing an eigen mime falls through to the 400 rather than into a transform over
    // the caller's bytes — the same gate exportDocument applies.
    const containerMime = isCollabType(path.type) ? path.mimeType : '';
    if (containerMime === DRIVE_MIME_SHEETS) {
        const snapshotJson = await importXlsxSnapshot(buffer, signal);
        const collabDoc = await drive.getCollabDocument(path.mountId, path.id);
        signal?.throwIfAborted();
        await requireWritePermission(drive, path, user);
        writeSheetsSnapshotToYjs(collabDoc.doc, snapshotJson);
        return;
    }

    if (containerMime === DRIVE_MIME_DOC) {
        const { update, page, style, images } = await importDocxUpdate(buffer, signal);
        // Media before the update that names it: an open tab looks each name up once, as the update arrives. The open
        // and the abort check come before the write check that guards the save.
        const collabDoc = await drive.getCollabDocument(path.mountId, path.id);
        signal?.throwIfAborted();
        await requireWritePermission(drive, path, user);
        await saveDocImages(drive, path, images, user);
        await requireWritePermission(drive, path, user);
        commitEigendocImport(collabDoc.doc, { update: new Uint8Array(update), page, style });
        return;
    }

    throw new ApiError(400, `Import into ${path.mimeType} is not supported`);
}
