import { prosemirrorJSONToYDoc } from '@tiptap/y-tiptap';
import * as Y from 'yjs';
import { ApiError } from '../../core/errors';
import { type DocImportWorkerResult, toTransferableBuffer } from '../../document/transform/protocol';
import { docSchema, docxToPmJson } from './from-docx';

// Uploaded docx bytes → the Yjs update the main thread commits, plus the extracted
// images it writes through Mount. Runs inside the transform Worker (worker.ts owns
// execution; the conversion logic stays here in import/, pure over the buffer), so
// mammoth, JSDOM, DOMPurify and the ProseMirror-to-Yjs conversion never touch the
// event loop.
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

// docx is a zip-based format — the parser needs the full file in memory to read the
// central directory and extract parts. Callers size-check before this point.
async function parseDocxOrThrow(buffer: Buffer) {
    try {
        return await docxToPmJson(buffer);
    } catch (err) {
        if (err instanceof ApiError) throw err;
        throw new ApiError(400, 'Not a valid docx file');
    }
}
