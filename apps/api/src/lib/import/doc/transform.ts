import type { JSONContent } from '@tiptap/core';
import { prosemirrorJSONToYDoc } from '@tiptap/y-tiptap';
import * as Y from 'yjs';
import { ApiError } from '../../core/errors';
import { type DocImportWorkerResult, toTransferableBuffer } from '../../document/transform/protocol';
import { type DocxImage, docSchema, docxToPmJson } from './from-docx';

// Uploaded docx bytes → the Yjs update the main thread commits, plus the extracted
// images it writes through Mount. Runs inside the transform Worker (worker.ts owns
// execution; the conversion logic stays here in import/, pure over the buffer), so
// mammoth, JSDOM, DOMPurify and the ProseMirror-to-Yjs conversion never touch the
// event loop. The zip guard rides along inside docxToPmJson with its exact 413, and
// anything else the parser throws becomes a 400.
export async function importDocxToEigendocUpdate(data: ArrayBuffer): Promise<DocImportWorkerResult> {
    const { json, images } = await parseDocxOrThrow(Buffer.from(data));

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
    };
}

async function parseDocxOrThrow(buffer: Buffer): Promise<{ json: JSONContent; images: DocxImage[] }> {
    try {
        return await docxToPmJson(buffer);
    } catch (err) {
        if (err instanceof ApiError) throw err;
        throw new ApiError(400, 'Not a valid docx file');
    }
}
