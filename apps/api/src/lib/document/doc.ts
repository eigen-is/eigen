import type { JSONContent } from '@tiptap/core';
import type { Schema } from '@tiptap/pm/model';
import { prosemirrorJSONToYDoc, yXmlFragmentToProsemirrorJSON } from '@tiptap/y-tiptap';
import * as Y from 'yjs';

// Materialized Yjs doc → ProseMirror JSON. Media-free, so it runs identically on the
// main thread and inside the document-transform Worker (which has no Mount). Every
// consumer of a persisted eigendoc reads it in the Worker, so the Mount-side loader is
// gone: capture (collab-source.ts) + materialize (yjs-loader.ts) is the only path in.
export function readEigendocFromDoc(doc: Y.Doc): JSONContent {
    return yXmlFragmentToProsemirrorJSON(doc.getXmlFragment('default'));
}

// The import commit: a Yjs update prepared elsewhere (the transform Worker) replaces
// the document's content. Clearing first is what makes an import a replacement — an
// applied update alone would append to whatever the document already holds.
export function writeEigendocUpdateToYjs(doc: Y.Doc, update: Uint8Array): void {
    doc.transact(() => {
        const fragment = doc.getXmlFragment('default');
        if (fragment.length > 0) fragment.delete(0, fragment.length);
    });
    Y.applyUpdate(doc, update);
}

export function writeEigendocToYjs(doc: Y.Doc, json: JSONContent, schema: Schema): void {
    const tempDoc = prosemirrorJSONToYDoc(schema, json, 'default');
    writeEigendocUpdateToYjs(doc, Y.encodeStateAsUpdate(tempDoc));
    tempDoc.destroy();
}
