import type { JSONContent } from '@tiptap/core';
import { prosemirrorJSONToYDoc } from '@tiptap/y-tiptap';
import * as Y from 'yjs';
import { ApiError } from '../../core/errors';
import {
    type DocImportWorkerResult,
    type TransformWarning,
    toTransferableBuffer,
} from '../../document/transform/protocol';
import { type DocxImage, docSchema, docxToPmJson } from './from-docx';

// Uploaded docx bytes → the Yjs update the main thread commits, plus the extracted
// images it writes through Mount. Runs inside the transform Worker (worker.ts owns
// execution; the conversion logic stays here in import/, pure over the buffer), so
// the reader and the ProseMirror-to-Yjs conversion never touch the event loop. The
// reader's own 400s and 413s pass through, and anything else it throws becomes a 400.
export async function importDocxToEigendocUpdate(
    data: ArrayBuffer,
    publicOrigin: string | undefined,
): Promise<DocImportWorkerResult & { warnings: TransformWarning[] }> {
    const { json, images, warnings } = await parseDocxOrThrow(Buffer.from(data), publicOrigin);

    const tempDoc = prosemirrorJSONToYDoc(docSchema, json, 'default');
    const update = Y.encodeStateAsUpdate(tempDoc);
    tempDoc.destroy();

    return {
        update: toTransferableBuffer(update),
        images: images.map((image) => ({
            name: image.name,
            contentType: image.contentType,
            data: toTransferableBuffer(image.data),
        })),
        warnings,
    };
}

async function parseDocxOrThrow(
    buffer: Buffer,
    publicOrigin: string | undefined,
): Promise<{ json: JSONContent; images: DocxImage[]; warnings: TransformWarning[] }> {
    try {
        return await docxToPmJson(buffer, { publicOrigin });
    } catch (err) {
        if (err instanceof ApiError) throw err;
        throw new ApiError(400, 'Not a valid docx file');
    }
}
