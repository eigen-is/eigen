import type { Node } from '@tiptap/pm/model';
import { EditorState } from '@tiptap/pm/state';
import { fixTables } from '@tiptap/pm/tables';
import { prosemirrorToYDoc } from '@tiptap/y-tiptap';
import * as Y from 'yjs';
import { ApiError } from '../../core/errors';
import {
    type DocImportWorkerResult,
    type TransformWarning,
    toTransferableBuffer,
} from '../../document/transform/protocol';
import { docSchema, docxToPmJson } from './from-docx';
import { DOCUMENT_TOO_LARGE } from './package';

// Uploaded docx bytes → the Yjs update the main thread commits, plus the extracted
// images it writes through Mount. Runs inside the transform Worker (worker.ts owns
// execution; the conversion logic stays here in import/, pure over the buffer), so
// the reader and the ProseMirror-to-Yjs conversion never touch the event loop. The
// reader refuses a file it can't read as a 400 or 413 itself.
export function importDocxToEigendocUpdate(
    data: ArrayBuffer,
    publicOrigin: string | undefined,
): DocImportWorkerResult & { warnings: TransformWarning[] } {
    const { json, images, warnings } = docxToPmJson(Buffer.from(data), { publicOrigin });

    let update: Uint8Array;
    try {
        const tempDoc = prosemirrorToYDoc(asOpened(docSchema.nodeFromJSON(json)), 'default');
        update = Y.encodeStateAsUpdate(tempDoc);
        tempDoc.destroy();
    } catch (error) {
        // y-tiptap passes a block's children to one call, which a cell of 700,000 paragraphs overflows.
        if (error instanceof RangeError) throw new ApiError(413, DOCUMENT_TOO_LARGE, { cause: error });
        throw error;
    }

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

// The doc as the editor leaves it on open, or the first open writes an edit nobody made, twice when two open it
// together: prosemirror-tables pads a ragged table and then gives the new cells their column's width, and
// TrailingNode ends the doc in a paragraph.
function asOpened(doc: Node): Node {
    let state = EditorState.create({ doc });
    for (let tr = fixTables(state); tr; tr = fixTables(state)) state = state.apply(tr);
    const { paragraph } = docSchema.nodes;
    if (state.doc.lastChild?.type === paragraph) return state.doc;
    return state.doc.copy(state.doc.content.addToEnd(paragraph.create()));
}
