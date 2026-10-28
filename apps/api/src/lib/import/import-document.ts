// Import into an open document and Convert to a new one, for xlsx, docx and pptx files: the main thread's half, which
// admits the job, hands the bytes to the transform process, then writes the pictures and commits what came back.
// Parsing, guards, recalc and serialization run in the transform process, so an import whose transform fails creates
// and changes nothing. Drive's import and convert routes, for example, call it.

import type { ConvertTarget, DocumentImportOptions, DrivePath } from '@workspace/lib/types/drive';
import {
    CONVERT_SOURCES,
    DRIVE_MIME_DOC,
    DRIVE_MIME_SHEETS,
    DRIVE_MIME_SLIDES,
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
import { commitEigendocImport } from '../document/doc';
import { appendSheetsToYjs, readLiveSheets, writeSheetsSnapshotToYjs } from '../document/sheets';
import { insertSlidesIntoYjs, readSlidesUpdate, replaceSlidesInYjs } from '../document/slides';
import { lossSummary } from '../document/transform/losses';
import type {
    DocImportJob,
    DocImportResult,
    ImportTransformJob,
    SheetsImportJob,
    SlidesImportJob,
    SlidesImportTransformResult,
    TransformMedia,
    TransformWarning,
} from '../document/transform/protocol';
import { toTransferableBuffer } from '../document/transform/protocol';
import type { SheetsImportSnapshot } from '../document/transform/run-transform';
import {
    runImportToDocumentUpdate,
    runImportToSlidesUpdate,
    runImportToSnapshotJson,
} from '../document/transform/run-transform';
import { documentTransformRunner } from '../document/transform/runner';
import type { DriveLike } from '../drive/get-drive';
import type { Mount } from '../mount';
import { MAX_DECOMPRESSED_BYTES } from '../ooxml/zip';
import type { User } from '../user';
import { IMPORT_MESSAGES, PRESENTATION_EMPTY } from './messages';
import { assertInsertFits } from './sheets/limits';

// No signal parameter by design: a conversion detaches from the request, so a page reload can't kill a minute of
// transform progress.
export async function convertToDocument(
    drive: DriveLike,
    mount: Mount,
    sourcePath: DrivePath,
    targetType: ConvertTarget,
    user: User,
    maxBytes: number,
): Promise<DrivePath> {
    const { parentId } = sourcePath;
    if (!parentId) throw new ApiError(400, 'Cannot convert a root file');

    const { format, type } = CONVERT_SOURCES[targetType];
    if (!isConvertSource(sourcePath.name, targetType)) {
        throw new ApiError(400, `Only .${format} files can be converted to ${EIGEN_DOC_TYPE_INFO[type].labelPlural}`);
    }
    // The create checks write too, but only after the transform: a reader would pay for one to get a 403.
    if (!(await drive.canWrite(sourcePath.mountId, parentId, user))) throw new ApiError(403, 'No write permission');
    // Buffering the source, possibly an S3 GET, is the costliest preparation here, so a job the runner won't admit
    // is refused before it.
    documentTransformRunner.assertAdmissible('foreground');
    assertWithinByteCap(sourcePath.size, format);
    // The upload limit may have been higher when the file was stored, so it applies here too.
    if (sourcePath.size > maxBytes) throw new ApiError(413, 'Source file too large');

    // The row's size is only a claim, so the read stops one byte past the lower cap and refuses what passes it, without
    // the rest ever being buffered. Past the byte cap, the check before the transform refuses it.
    const bytes = await mount.readBytes(sourcePath.id, Math.min(maxBytes, MAX_DECOMPRESSED_BYTES) + 1);
    if (!bytes) throw new ApiError(404, 'File not found');
    if (bytes.byteLength > maxBytes) throw new ApiError(413, 'Source file too large');
    const buffer = Buffer.from(bytes);
    const name = sourcePath.name.slice(0, -`.${format}`.length);

    if (targetType === 'eigensheets') {
        const { snapshotJson, images } = await importXlsxSnapshot(buffer);
        // Refused before the create, so a file whose pictures can't fit makes no document. saveImportedImages charges
        // again.
        await enforceMountQuota(sourcePath.ownerId, sourcePath.mountId, imagesSize(images));
        const newPath = await drive.create(sourcePath.mountId, parentId, name, type, user);
        return fillNewDocument(drive, newPath, user, async (doc) => {
            await saveImportedImages(drive, newPath, images, user);
            writeSheetsSnapshotToYjs(doc, snapshotJson);
        });
    }

    if (targetType === 'eigenslides') {
        // No deck: the new one takes the slide size nearest the file's and the file's width, so a 4:3 file makes a 4:3
        // deck.
        const { update, images } = await importPptxUpdate(buffer, undefined);
        await enforceMountQuota(sourcePath.ownerId, sourcePath.mountId, imagesSize(images));
        const newPath = await drive.create(sourcePath.mountId, parentId, name, type, user);
        return fillNewDocument(drive, newPath, user, async (doc) => {
            await saveImportedImages(drive, newPath, images, user);
            // A file with no slides makes a deck with none, which the Slides editor seeds as it does a new one.
            replaceSlidesInYjs(doc, readSlidesUpdate(new Uint8Array(update)));
        });
    }

    const { update, page, style, images } = await importDocxUpdate(buffer);
    await enforceMountQuota(sourcePath.ownerId, sourcePath.mountId, imagesSize(images));
    const newPath = await drive.create(sourcePath.mountId, parentId, name, type, user);
    return fillNewDocument(drive, newPath, user, async (doc) => {
        await saveImportedImages(drive, newPath, images, user);
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
    // The container's type gates the dispatch, as exportDocument's does. The mime type is the caller's on an upload,
    // so a plain file wearing an Eigen mime type gets the 400 rather than a transform over the caller's bytes.
    const containerMime = isCollabType(path.type) ? path.mimeType : '';
    const commit = { drive, path, user, signal };
    if (containerMime === DRIVE_MIME_SHEETS) {
        const { snapshotJson, weight, images, warnings } = await importXlsxSnapshot(buffer, signal);
        // An insert is weighed with the workbook before its pictures are saved, so a refused one leaves none behind.
        // The write weighs it again, because another insert may have grown the workbook in the meantime.
        if (mode === 'insert' && images.length > 0) {
            assertInsertFits(readLiveSheets((await drive.getCollabDocument(path.mountId, path.id)).doc), weight);
        }
        await commitImport(commit, images, mode === 'replace', (doc) => {
            if (mode === 'replace') return writeSheetsSnapshotToYjs(doc, snapshotJson);
            const current = readLiveSheets(doc);
            assertInsertFits(current, weight);
            appendSheetsToYjs(doc, snapshotJson, current);
        });
        return lossSummary(warnings, 'import');
    }

    if (containerMime === DRIVE_MIME_DOC) {
        // The file's page setup, Normal style and bands can't sit beside the doc's, so a docx only ever replaces.
        if (mode !== 'replace') throw new ApiError(400, 'A document import replaces the document');
        const { update, page, style, images, warnings } = await importDocxUpdate(buffer, signal);
        await commitImport(commit, images, true, (doc) => {
            commitEigendocImport(doc, { update: new Uint8Array(update), page, style });
        });
        return lossSummary(warnings, 'import');
    }

    if (containerMime === DRIVE_MIME_SLIDES) {
        // Refused before the deck is opened for its page. An insert fits a file of another size into the deck's frame,
        // letterboxed. A replace takes the slide size nearest the file's and the file's width, as Convert does.
        documentTransformRunner.assertAdmissible('foreground');
        assertWithinByteCap(buffer.byteLength, 'pptx');
        const deck =
            mode === 'insert' ? readSlidePage((await drive.getCollabDocument(path.mountId, path.id)).doc) : undefined;
        const { update, images, warnings } = await importPptxUpdate(buffer, deck, signal);
        // A file with no slides has no pictures either, so nothing is saved or written.
        const scene = readSlidesUpdate(new Uint8Array(update));
        if (scene.frames.length === 0) return PRESENTATION_EMPTY;
        await commitImport(commit, images, mode === 'replace', (doc) => {
            if (mode === 'replace') replaceSlidesInYjs(doc, scene);
            else insertSlidesIntoYjs(doc, scene, afterFrameId);
        });
        return lossSummary(warnings, 'import');
    }

    throw new ApiError(400, `Import into ${path.mimeType} is not supported`);
}

// Every format commits in one order. The document is opened after the transform, because the last tab leaving during
// it closes the document, and a write into a closed one is lost. A replace saves a version first. The pictures
// are saved before the write that names them, because an open tab looks each name up once, as the write arrives. The
// write check is the last await before the synchronous write. Each import prefixes its picture names, so they land
// beside the document's media, never over it.
async function commitImport(
    { drive, path, user, signal }: { drive: DriveLike; path: DrivePath; user: User; signal?: AbortSignal },
    images: TransformMedia[],
    replace: boolean,
    write: (doc: Y.Doc) => void,
): Promise<void> {
    const collabDoc = await drive.getCollabDocument(path.mountId, path.id);
    signal?.throwIfAborted();
    if (replace) await drive.saveVersion(path.mountId, path.id);
    await saveImportedImages(drive, path, images, user);
    await requireWritePermission(drive, path, user);
    write(collabDoc.doc);
}

// A job the runner won't admit is refused before the copy: a view over a larger pool is copied out, and IPC copies the
// upload again. The runner checks again when it runs the job.
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

function importDocxUpdate(buffer: Buffer, signal?: AbortSignal): Promise<DocImportResult> {
    documentTransformRunner.assertAdmissible('foreground');
    assertWithinByteCap(buffer.byteLength, 'docx');
    const job: DocImportJob = {
        kind: 'import',
        sourceFormat: 'docx',
        targetType: 'eigendoc',
        publicOrigin: getPublicOrigin(),
        maxMediaBytes: getMaxUploadSize(),
    };
    return runImportToDocumentUpdate(job, toTransferableBuffer(buffer), { signal });
}

function importPptxUpdate(
    buffer: Buffer,
    deck: SlidesImportJob['deck'],
    signal?: AbortSignal,
): Promise<SlidesImportTransformResult & { warnings: TransformWarning[] }> {
    documentTransformRunner.assertAdmissible('foreground');
    assertWithinByteCap(buffer.byteLength, 'pptx');
    return runImportToSlidesUpdate(
        { kind: 'import', sourceFormat: 'pptx', targetType: 'eigenslides', deck, maxMediaBytes: getMaxUploadSize() },
        toTransferableBuffer(buffer),
        { signal },
    );
}

// openZip refuses an archive past the byte cap anyway. Refused here, a file that large is never read or copied to the
// transform. The upload cap allows up to a gigabyte, and a convert reads a stored file of any size.
function assertWithinByteCap(bytes: number, format: ImportTransformJob['sourceFormat']): void {
    if (bytes > MAX_DECOMPRESSED_BYTES) throw new ApiError(413, IMPORT_MESSAGES[format].tooLarge);
}

// The route checked write before it buffered, but the job can queue and transform for minutes, long enough for a share
// to be revoked. getCollabDocument checks only read, so the commit needs a write check of its own.
async function requireWritePermission(drive: DriveLike, path: DrivePath, user: User): Promise<void> {
    if (!(await drive.canWrite(path.mountId, path.id, user))) throw new ApiError(403, 'No write permission');
}

// Through Drive, as an upload is: the ACL check, the drive event an open tab redraws on and the thumbnail. The images
// count toward the quota at their inflated size. They are charged before the first is written.
// Each import names its pictures with a prefix of its own, so every one is a create.
async function saveImportedImages(
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

function imagesSize(images: TransformMedia[]): number {
    return images.reduce((sum, image) => sum + image.data.byteLength, 0);
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
