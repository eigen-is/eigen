import type { Node } from '@tiptap/pm/model';
import { EditorState } from '@tiptap/pm/state';
import { fixTables, TableMap } from '@tiptap/pm/tables';
import { prosemirrorToYDoc, prosemirrorToYXmlFragment } from '@tiptap/y-tiptap';
import * as Y from 'yjs';
import { ApiError } from '../../core/errors';
import { docSchema } from '../../document/doc-schema';
import type { DocImportWorkerResult, TransformWarning } from '../../document/transform/protocol';
import { toTransferableBuffer, toTransferableMedia } from '../../document/transform/protocol';
import { IMPORT_MESSAGES, importError } from '../messages';
import { readDocx } from './from-docx';

// Runs in the transform process, so neither the reader nor the conversion to Yjs blocks the event loop. The main thread
// commits the update and writes the images through Mount.
export function importDocxToEigendocUpdate(
    data: ArrayBuffer,
    publicOrigin: string | undefined,
): DocImportWorkerResult & { warnings: TransformWarning[] } {
    const { doc, bands, page, style, images, warnings } = readDocx(Buffer.from(data), { publicOrigin });
    let update: Uint8Array;
    try {
        // The bands ride in the update beside the body; the commit clears every root before it applies.
        const tempDoc = prosemirrorToYDoc(asOpened(doc), 'default');
        for (const [root, band] of Object.entries(bands))
            prosemirrorToYXmlFragment(asOpened(band), tempDoc.getXmlFragment(root));
        update = Y.encodeStateAsUpdate(tempDoc);
        tempDoc.destroy();
    } catch (error) {
        throw importError(error, 'docx');
    }

    return {
        update: toTransferableBuffer(update),
        page,
        style,
        images: toTransferableMedia(images),
        warnings,
    };
}

// fixTables' transaction keeps a copy of the table per repair, so a table's repairs are bounded before they run.
export const MAX_TABLE_REPAIRS = 10_000_000;

// The doc or band as its editor leaves it on open, or the first open writes an edit nobody made, twice when two open it
// together: prosemirror-tables repairs a table the reader got wrong, and TrailingNode ends the doc in a paragraph.
export function asOpened(doc: Node): Node {
    eachTable(doc, (table, repairs) => {
        if (repairs * table.childCount > MAX_TABLE_REPAIRS) throw new ApiError(413, IMPORT_MESSAGES.docx.tooLarge);
    });
    const repaired = fixTables(EditorState.create({ doc }))?.doc ?? doc;
    // A repair can leave another for a second pass; the reader writes tables that need none, so one that would is refused.
    eachTable(repaired, (_table, repairs) => {
        if (repairs > 0) throw new ApiError(413, IMPORT_MESSAGES.docx.tooLarge);
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
