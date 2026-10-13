import {
    CONVERT_SOURCES,
    type ConvertResult,
    type ConvertTarget,
    DRIVE_MIME_DOC,
    DRIVE_MIME_SHEETS,
    DRIVE_MIME_SLIDES,
    DRIVE_TYPE_FILE,
    type DrivePath,
    EIGEN_DOC_TYPE_INFO,
    isCollabType,
    isConvertSource,
} from '@workspace/lib/types/drive';
import { FRAME_HEIGHT, FRAME_WIDTH } from '@workspace/lib/vector';
import { enforceMountQuota } from '../config/enforcement';
import { getPublicOrigin } from '../config/server-config';
import { getMaxUploadSize } from '../config/server-settings';
import { ApiError } from '../core/errors';
import { MAX_DECOMPRESSED_BYTES } from '../core/zip';
import { writeEigendocUpdateToYjs } from '../document/doc';
import { writeSheetsSnapshotToYjs } from '../document/sheets';
import { appendSlidesUpdateToYjs, writeSlidesUpdateToYjs } from '../document/slides';
import {
    type DocImportWorkerResult,
    type ImportTransformJob,
    type SheetsImportJob,
    type SlidesImportJob,
    type TransformMedia,
    type TransformWarning,
    toTransferableBuffer,
} from '../document/transform/protocol';
import { runImportToDocumentUpdate, runImportToSnapshotJson } from '../document/transform/run-transform';
import { documentTransformRunner } from '../document/transform/runner';
import type { DriveLike } from '../drive/get-drive';
import type { Mount } from '../mount';
import type { User } from '../user';
import { IMPORT_TOO_LARGE, importSummary, PRESENTATION_EMPTY } from './messages';

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

type DocumentImport = DocImportWorkerResult & { warnings: TransformWarning[] };

function importDocxUpdate(buffer: Buffer, signal?: AbortSignal): Promise<DocumentImport> {
    documentTransformRunner.assertAdmissible('foreground');
    assertWithinByteCap(buffer.byteLength, 'docx');
    return runImportToDocumentUpdate(
        { kind: 'import', sourceFormat: 'docx', targetType: 'eigendoc', publicOrigin: getPublicOrigin() },
        toTransferableBuffer(buffer),
        { signal },
    );
}

// The upload cap bounds the pictures' inflated bytes too, as an upload of each would be bounded.
function importPptxUpdate(
    buffer: Buffer,
    frame: SlidesImportJob['frame'],
    signal?: AbortSignal,
): Promise<DocumentImport> {
    documentTransformRunner.assertAdmissible('foreground');
    assertWithinByteCap(buffer.byteLength, 'pptx');
    return runImportToDocumentUpdate(
        { kind: 'import', sourceFormat: 'pptx', targetType: 'eigenslides', frame, maxMediaBytes: getMaxUploadSize() },
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
): Promise<ConvertResult> {
    if (!sourcePath.parentId) throw new ApiError(400, 'Cannot convert a root file');

    // Refuse before the stored-file read: buffering the source (possibly an S3 GET)
    // is the costliest preparation here. run() rechecks authoritatively.
    documentTransformRunner.assertAdmissible('foreground');
    const { format, type } = CONVERT_SOURCES[targetType];
    if (!isConvertSource(sourcePath.name, targetType)) {
        throw new ApiError(400, `Only .${format} files can be converted to ${EIGEN_DOC_TYPE_INFO[type].labelPlural}`);
    }
    assertWithinByteCap(sourcePath.size, format);

    const bytes = await mount.readBytes(sourcePath.id);
    if (!bytes) throw new ApiError(404, 'File not found');
    const buffer = Buffer.from(bytes);
    const name = sourcePath.name.slice(0, -`.${format}`.length);

    if (targetType === 'eigensheets') {
        const snapshotJson = await importXlsxSnapshot(buffer);
        const newPath = await drive.create(sourcePath.mountId, sourcePath.parentId, name, type, user);
        const collabDoc = await drive.getCollabDocument(sourcePath.mountId, newPath.id);
        writeSheetsSnapshotToYjs(collabDoc.doc, snapshotJson);
        return { path: newPath, summary: null };
    }

    const slides = targetType === 'eigenslides';
    // No frame for a deck: the new one takes the size the file's slide size picks.
    const { update, images, warnings } = slides
        ? await importPptxUpdate(buffer, undefined)
        : await importDocxUpdate(buffer);
    // Refused before the create, so no empty document is left behind; saveDocImages charges again as it writes.
    await enforceMountQuota(sourcePath.ownerId, sourcePath.mountId, imagesSize(images));
    const newPath = await drive.create(sourcePath.mountId, sourcePath.parentId, name, type, user);
    const collabDoc = await drive.getCollabDocument(sourcePath.mountId, newPath.id);
    await saveDocImages(drive, newPath, images, user);
    if (slides) {
        // A file with no slides makes a deck with none, which the Slides editor seeds as it does a new one.
        writeSlidesUpdateToYjs(collabDoc.doc, new Uint8Array(update));
        return { path: newPath, summary: importSummary(warnings) };
    }
    writeEigendocUpdateToYjs(collabDoc.doc, new Uint8Array(update));
    return { path: newPath, summary: null };
}

// Answers the summary of what the file held that did not come over, for the toast.
export async function importIntoDocument(
    drive: DriveLike,
    path: DrivePath,
    buffer: Buffer,
    user: User,
    signal?: AbortSignal,
): Promise<string | null> {
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
        return null;
    }

    if (containerMime === DRIVE_MIME_DOC) {
        const { update, images } = await importDocxUpdate(buffer, signal);
        // Media before the update that names it: an open tab looks each name up once, as the update arrives. The open
        // and the abort check come before the write check that guards the save.
        const collabDoc = await drive.getCollabDocument(path.mountId, path.id);
        signal?.throwIfAborted();
        await requireWritePermission(drive, path, user);
        await saveDocImages(drive, path, images, user);
        await requireWritePermission(drive, path, user);
        writeEigendocUpdateToYjs(collabDoc.doc, new Uint8Array(update));
        return null;
    }

    if (containerMime === DRIVE_MIME_SLIDES) {
        // The deck's own frame, which every deck shares today: the slides are fitted into it, letterboxed. The importer
        // prefixes its picture names per import, so they land beside the deck's media, never over it.
        const frame = { width: FRAME_WIDTH, height: FRAME_HEIGHT };
        const { update, images, warnings } = await importPptxUpdate(buffer, frame, signal);
        // As the docx branch: media before the update that names it, the write check last.
        const collabDoc = await drive.getCollabDocument(path.mountId, path.id);
        signal?.throwIfAborted();
        await requireWritePermission(drive, path, user);
        await saveDocImages(drive, path, images, user);
        await requireWritePermission(drive, path, user);
        // A file with no slides has no pictures either, so nothing was written.
        const appended = appendSlidesUpdateToYjs(collabDoc.doc, new Uint8Array(update));
        return appended === 0 ? PRESENTATION_EMPTY : importSummary(warnings);
    }

    throw new ApiError(400, `Import into ${path.mimeType} is not supported`);
}
