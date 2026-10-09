import { prosemirrorJSONToYDoc } from '@tiptap/y-tiptap';
import * as Y from 'yjs';
import {
    type DocImportWorkerResult,
    type TransformWarning,
    toTransferableBuffer,
} from '../../document/transform/protocol';
import { docSchema, docxToPmJson } from './from-docx';

// Uploaded docx bytes → the Yjs update the main thread commits, plus the extracted
// images it writes through Mount. Runs inside the transform Worker (worker.ts owns
// execution; the conversion logic stays here in import/, pure over the buffer), so
// the reader and the ProseMirror-to-Yjs conversion never touch the event loop. The
// reader refuses a file it can't read as a 400 or 413 itself.
export async function importDocxToEigendocUpdate(
    data: ArrayBuffer,
    publicOrigin: string | undefined,
): Promise<DocImportWorkerResult & { warnings: TransformWarning[] }> {
    const { json, images, warnings } = await docxToPmJson(Buffer.from(data), { publicOrigin });

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
