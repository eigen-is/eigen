import {
    CONVERT_SOURCES,
    type ConvertTarget,
    type DocumentImportOptions,
    DRIVE_MIME_DOC,
    DRIVE_MIME_SHEETS,
    DRIVE_MIME_SLIDES,
    type DrivePath,
    EIGEN_DOC_TYPE_INFO,
    isCollabType,
    isConvertSource,
} from '@workspace/lib/types/drive';
import { readSlidePage } from '@workspace/lib/vector';
import type * as Y from 'yjs';
import { enforceMountQuota } from '../config/enforcement';
import { getPublicOrigin } from '../config/server-config';
import { getMaxUploadSize } from '../config/server-settings';
import { ApiError } from '../core/errors';
import { MAX_DECOMPRESSED_BYTES } from '../core/zip';
import { commitEigendocImport } from '../document/doc';
import { appendSheetsToYjs, writeSheetsSnapshotToYjs } from '../document/sheets';
import { insertSlidesIntoYjs, readSlidesUpdate, replaceSlidesInYjs } from '../document/slides';
import {
    type DocImportWorkerResult,
    type ImportTransformJob,
    type SheetsImportJob,
    type SlidesImportJob,
    type SlidesImportWorkerResult,
    type TransformMedia,
    type TransformWarning,
    toTransferableBuffer,
} from '../document/transform/protocol';
import {
    runImportToDocumentUpdate,
    runImportToSlidesUpdate,
    runImportToSnapshotJson,
    type SheetsImportSnapshot,
} from '../document/transform/run-transform';
import { documentTransformRunner } from '../document/transform/runner';
import type { DriveLike } from '../drive/get-drive';
import type { Mount } from '../mount';
import type { User } from '../user';
import { IMPORT_MESSAGES, importSummary, PRESENTATION_EMPTY } from './messages';

// Parsing, guards, recalc and serialization run in the transform process; the main
// thread only commits what it returns — the snapshot for sheets, a ready Yjs update
// plus extracted media for documents. Nothing is created or mutated before the transform
// succeeds, so a failed import leaves source and target untouched.
// Refuse before the copy: a view over a larger pool is copied out, and IPC copies the
// upload again, so a job the runner will not admit must not pay for it. run() rechecks
// authoritatively. The upload cap bounds the pictures' inflated bytes too, as an upload of each would be bounded.
function importXlsxSnapshot(buffer: Buffer, signal?: AbortSignal): Promise<SheetsImportSnapshot> {
    documentTransformRunner.assertAdmissible('foreground');
    assertWithinByteCap(buffer.byteLength, 'xlsx');
    const job: SheetsImportJob = {
        kind: 'import',
        sourceFormat: 'xlsx',
        targetType: 'eigensheets',
        maxMediaBytes: getMaxUploadSize(),
    };
    return runImportToSnapshotJson(job, toTransferableBuffer(buffer), { signal });
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

// The upload cap bounds the pictures' inflated bytes too, as an upload of each would be bounded.
function importPptxUpdate(
    buffer: Buffer,
    deck: SlidesImportJob['deck'],
    signal?: AbortSignal,
): Promise<SlidesImportWorkerResult & { warnings: TransformWarning[] }> {
    documentTransformRunner.assertAdmissible('foreground');
    assertWithinByteCap(buffer.byteLength, 'pptx');
    return runImportToSlidesUpdate(
        { kind: 'import', sourceFormat: 'pptx', targetType: 'eigenslides', deck, maxMediaBytes: getMaxUploadSize() },
        toTransferableBuffer(buffer),
        { signal },
    );
}

// openZip refuses an archive past the byte cap anyway; refused here, a file that large is never read or copied to the
// transform. The upload cap allows up to a gigabyte, and a convert reads a stored file of any size.
function assertWithinByteCap(bytes: number, format: ImportTransformJob['sourceFormat']): void {
    if (bytes > MAX_DECOMPRESSED_BYTES) throw new ApiError(413, IMPORT_MESSAGES[format].tooLarge);
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
// count toward the quota, inflated up to the zip cap, and are charged before the first is written. Each import names its
// pictures with a prefix of its own, so every one is a create.
async function saveDocImages(
    drive: DriveLike,
    docPath: DrivePath,
    images: TransformMedia[],
    user: User,
): Promise<void> {
    if (images.length === 0) return;
    const mediaFolder = await drive.getChildByName(docPath.mountId, docPath.id, 'media');
    if (!mediaFolder) throw new ApiError(500, 'Document media folder not found');
    await enforceMountQuota(docPath.ownerId, docPath.mountId, imagesSize(images));
    for (const image of images) {
        const data = Buffer.from(image.data);
        await drive.createFileFromData(docPath.mountId, mediaFolder.id, image.name, image.contentType, data, user);
    }
}

// A convert that fails after its create (quota another write spent) trashes the document it made through Drive's own
// delete, so the error it answers leaves no half-filled document behind.
async function fillNewDocument(
    drive: DriveLike,
    newPath: DrivePath,
    user: User,
    fill: (doc: Y.Doc) => Promise<void> | void,
): Promise<DrivePath> {
    try {
        const collabDoc = await drive.getCollabDocument(newPath.mountId, newPath.id);
        await fill(collabDoc.doc);
        return newPath;
    } catch (error) {
        await drive.deletePath(newPath.mountId, newPath.id, user).catch((deleteError: unknown) => {
            console.warn(`[import] convert cleanup failed for ${newPath.id}:`, deleteError);
        });
        throw error;
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
    const { parentId } = sourcePath;
    if (!parentId) throw new ApiError(400, 'Cannot convert a root file');

    const { format, type } = CONVERT_SOURCES[targetType];
    if (!isConvertSource(sourcePath.name, targetType)) {
        throw new ApiError(400, `Only .${format} files can be converted to ${EIGEN_DOC_TYPE_INFO[type].labelPlural}`);
    }
    // The create checks write too, but only after the transform: a reader would pay for one to get a 403.
    if (!(await drive.canWrite(sourcePath.mountId, parentId, user))) throw new ApiError(403, 'No write permission');
    // Refuse before the stored-file read: buffering the source (possibly an S3 GET)
    // is the costliest preparation here. run() rechecks authoritatively.
    documentTransformRunner.assertAdmissible('foreground');
    assertWithinByteCap(sourcePath.size, format);

    const bytes = await mount.readBytes(sourcePath.id);
    if (!bytes) throw new ApiError(404, 'File not found');
    const buffer = Buffer.from(bytes);
    const name = sourcePath.name.slice(0, -`.${format}`.length);

    if (targetType === 'eigensheets') {
        const { snapshotJson, images } = await importXlsxSnapshot(buffer);
        // Refused before the create, as a deck's: a file whose pictures can't fit makes no document.
        await enforceMountQuota(sourcePath.ownerId, sourcePath.mountId, imagesSize(images));
        const newPath = await drive.create(sourcePath.mountId, parentId, name, type, user);
        return fillNewDocument(drive, newPath, user, async (doc) => {
            await saveDocImages(drive, newPath, images, user);
            writeSheetsSnapshotToYjs(doc, snapshotJson);
        });
    }

    if (targetType === 'eigenslides') {
        // No deck: the new one takes the slide size nearest the file's and the file's width, so a 4:3 file makes a 4:3
        // deck.
        const { update, images } = await importPptxUpdate(buffer, undefined);
        // Refused before the create, so a file whose pictures can't fit makes no document; saveDocImages charges again.
        await enforceMountQuota(sourcePath.ownerId, sourcePath.mountId, imagesSize(images));
        const newPath = await drive.create(sourcePath.mountId, parentId, name, type, user);
        return fillNewDocument(drive, newPath, user, async (doc) => {
            await saveDocImages(drive, newPath, images, user);
            // A file with no slides makes a deck with none, which the Slides editor seeds as it does a new one.
            replaceSlidesInYjs(doc, readSlidesUpdate(new Uint8Array(update)));
        });
    }

    const { update, page, style, images } = await importDocxUpdate(buffer);
    await enforceMountQuota(sourcePath.ownerId, sourcePath.mountId, imagesSize(images));
    const newPath = await drive.create(sourcePath.mountId, parentId, name, type, user);
    return fillNewDocument(drive, newPath, user, async (doc) => {
        await saveDocImages(drive, newPath, images, user);
        commitEigendocImport(doc, { update: new Uint8Array(update), page, style });
    });
}

// Answers the summary of what the file held that did not come over, for the toast. A replace saves a version first, so
// the document as it was is one restore away in its version history.
export async function importIntoDocument(
    drive: DriveLike,
    path: DrivePath,
    buffer: Buffer,
    { mode, afterFrameId }: DocumentImportOptions,
    user: User,
    signal?: AbortSignal,
): Promise<string | null> {
    // The container TYPE gates the dispatch: mimeType is caller-controlled on upload, so a plain
    // file wearing an eigen mime falls through to the 400 rather than into a transform over
    // the caller's bytes — the same gate exportDocument applies.
    const containerMime = isCollabType(path.type) ? path.mimeType : '';
    if (containerMime === DRIVE_MIME_SHEETS) {
        const { snapshotJson, images, warnings } = await importXlsxSnapshot(buffer, signal);
        // As a deck's: media before the snapshot that names it, the write check last. The importer prefixes its
        // picture names per import, so they land beside the workbook's media, never over it.
        const collabDoc = await drive.getCollabDocument(path.mountId, path.id);
        signal?.throwIfAborted();
        if (mode === 'replace') await drive.saveVersion(path.mountId, path.id);
        await requireWritePermission(drive, path, user);
        await saveDocImages(drive, path, images, user);
        await requireWritePermission(drive, path, user);
        if (mode === 'replace') writeSheetsSnapshotToYjs(collabDoc.doc, snapshotJson);
        else appendSheetsToYjs(collabDoc.doc, snapshotJson);
        return importSummary(warnings);
    }

    if (containerMime === DRIVE_MIME_DOC) {
        // The file's page setup, Normal style and bands can't sit beside the doc's, so a docx only ever replaces.
        if (mode !== 'replace') throw new ApiError(400, 'A document import replaces the document');
        const { update, page, style, images } = await importDocxUpdate(buffer, signal);
        // Media before the update that names it: an open tab looks each name up once, as the update arrives. The open
        // and the abort check come before the version and the write check that guards the save.
        const collabDoc = await drive.getCollabDocument(path.mountId, path.id);
        signal?.throwIfAborted();
        await drive.saveVersion(path.mountId, path.id);
        await requireWritePermission(drive, path, user);
        await saveDocImages(drive, path, images, user);
        await requireWritePermission(drive, path, user);
        commitEigendocImport(collabDoc.doc, { update: new Uint8Array(update), page, style });
        return null;
    }

    if (containerMime === DRIVE_MIME_SLIDES) {
        // Refused before the deck is opened for its page. An insert fits a file of another size into the deck's frame,
        // letterboxed; a replace takes the slide size nearest the file's and the file's width, as Convert does. The
        // importer prefixes its picture names per import, so they land beside the deck's media, never over it.
        documentTransformRunner.assertAdmissible('foreground');
        assertWithinByteCap(buffer.byteLength, 'pptx');
        const deck =
            mode === 'insert' ? readSlidePage((await drive.getCollabDocument(path.mountId, path.id)).doc) : undefined;
        const { update, images, warnings } = await importPptxUpdate(buffer, deck, signal);
        // A file with no slides has no pictures either: nothing is saved or written.
        const scene = readSlidesUpdate(new Uint8Array(update));
        if (scene.frames.length === 0) return PRESENTATION_EMPTY;
        // Opened again: the last tab leaving during the transform closes the deck, and a write into a closed one is lost.
        // As the docx branch: media before the update that names it, the write check last.
        const collabDoc = await drive.getCollabDocument(path.mountId, path.id);
        signal?.throwIfAborted();
        if (mode === 'replace') await drive.saveVersion(path.mountId, path.id);
        await requireWritePermission(drive, path, user);
        await saveDocImages(drive, path, images, user);
        await requireWritePermission(drive, path, user);
        if (mode === 'replace') replaceSlidesInYjs(collabDoc.doc, scene);
        else insertSlidesIntoYjs(collabDoc.doc, scene, afterFrameId);
        return importSummary(warnings);
    }

    throw new ApiError(400, `Import into ${path.mimeType} is not supported`);
}
