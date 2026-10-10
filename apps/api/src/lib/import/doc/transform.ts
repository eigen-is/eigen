import type { Node } from '@tiptap/pm/model';
import { EditorState } from '@tiptap/pm/state';
import { fixTables, TableMap } from '@tiptap/pm/tables';
import { prosemirrorToYDoc } from '@tiptap/y-tiptap';
import * as Y from 'yjs';
import { ApiError } from '../../core/errors';
import { docSchema } from '../../document/doc-schema';
import {
    type DocImportWorkerResult,
    type TransformWarning,
    toTransferableBuffer,
} from '../../document/transform/protocol';
import { importError, readDocx } from './from-docx';
import { DOCUMENT_TOO_LARGE } from './package';

// Uploaded docx bytes → the Yjs update the main thread commits, plus the extracted
// images it writes through Mount. Runs inside the transform Worker (worker.ts owns
// execution; the conversion logic stays here in import/, pure over the buffer), so
// the reader and the ProseMirror-to-Yjs conversion never touch the event loop. Both
// refuse a file they can't take as a 400 or 413.
export function importDocxToEigendocUpdate(
    data: ArrayBuffer,
    publicOrigin: string | undefined,
): DocImportWorkerResult & { warnings: TransformWarning[] } {
    const { doc, images, warnings } = readDocx(Buffer.from(data), { publicOrigin });
    let update: Uint8Array;
    try {
        const tempDoc = prosemirrorToYDoc(asOpened(doc), 'default');
        update = Y.encodeStateAsUpdate(tempDoc);
        tempDoc.destroy();
    } catch (error) {
        throw importError(error);
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

// fixTables' transaction keeps a copy of the table per repair, so a table's repairs are bounded before they run.
export const MAX_TABLE_REPAIRS = 10_000_000;

// The doc as the editor leaves it on open, or the first open writes an edit nobody made, twice when two open it
// together: prosemirror-tables repairs a table the reader got wrong, and TrailingNode ends the doc in a paragraph.
export function asOpened(doc: Node): Node {
    eachTable(doc, (table, repairs) => {
        if (repairs * table.childCount > MAX_TABLE_REPAIRS) throw new ApiError(413, DOCUMENT_TOO_LARGE);
    });
    const repaired = fixTables(EditorState.create({ doc }))?.doc ?? doc;
    // A repair can leave another for a second pass; the reader writes tables that need none, so one that would is refused.
    eachTable(repaired, (_table, repairs) => {
        if (repairs > 0) throw new ApiError(413, DOCUMENT_TOO_LARGE);
    });
    const { paragraph } = docSchema().nodes;
    if (repaired.lastChild?.type === paragraph) return repaired;
    return repaired.copy(repaired.content.addToEnd(paragraph.create()));
}

function eachTable(doc: Node, visit: (table: Node, repairs: number) => void): void {
    doc.descendants((node) => {
        if (node.type.spec['tableRole'] === 'table') visit(node, TableMap.get(node).problems?.length ?? 0);
    });
}
