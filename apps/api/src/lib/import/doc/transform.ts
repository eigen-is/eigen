import type { Node } from '@tiptap/pm/model';
import { EditorState } from '@tiptap/pm/state';
import { fixTables, TableMap } from '@tiptap/pm/tables';
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

    const tempDoc = prosemirrorToYDoc(asOpened(docSchema.nodeFromJSON(json)), 'default');
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

// fixTables' transaction keeps a copy of the table per repair: 5,000 repairs of a 5,000-row table took 283 MB, twice
// that many 930 MB.
export const MAX_TABLE_REPAIRS = 10_000_000;

// The doc as the editor leaves it on open, or the first open writes an edit nobody made, twice when two open it
// together: prosemirror-tables pads a ragged table and then gives the new cells their column's width, and
// TrailingNode ends the doc in a paragraph. The reader opens its tables itself, so fixTables is the safety net.
export function asOpened(doc: Node): Node {
    let state = EditorState.create({ doc });
    for (;;) {
        state.doc.descendants((node) => {
            if (node.type.spec['tableRole'] !== 'table') return;
            const repairs = TableMap.get(node).problems?.length ?? 0;
            if (repairs * node.childCount > MAX_TABLE_REPAIRS) throw new ApiError(413, DOCUMENT_TOO_LARGE);
        });
        const tr = fixTables(state);
        if (!tr) break;
        state = state.apply(tr);
    }
    const { paragraph } = docSchema.nodes;
    if (state.doc.lastChild?.type === paragraph) return state.doc;
    return state.doc.copy(state.doc.content.addToEnd(paragraph.create()));
}
