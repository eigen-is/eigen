import type { JSONContent } from '@tiptap/core';
import type { Schema } from '@tiptap/pm/model';
import { prosemirrorJSONToYDoc, yXmlFragmentToProsemirrorJSON } from '@tiptap/y-tiptap';
import type { DrivePath } from '@workspace/lib/types/drive';
import * as Y from 'yjs';
import { COLLAB_DB_CONFIG } from '../collab/db-config';
import { loadYjsState } from '../collab/yjs-loader';
import type { Mount } from '../mount';
import { listDocumentMedia } from './media';

export type EigendocContent = {
    json: JSONContent;
    mediaByName: Map<string, DrivePath>;
};

// Materialized Yjs doc → ProseMirror JSON. Media-free, so it runs identically on the
// main thread and inside the document-transform Worker (which has no Mount).
export function readEigendocFromDoc(doc: Y.Doc): JSONContent {
    return yXmlFragmentToProsemirrorJSON(doc.getXmlFragment('default'));
}

export async function readEigendocContent(mount: Mount, drivePath: DrivePath): Promise<EigendocContent> {
    const dataDbPath = await mount.getChildByName(drivePath.id, 'data.db');
    if (!dataDbPath) throw new Error('eigendoc data.db missing');

    // Open (or reuse) the database — don't close it, as a collab session may share
    // this instance. Mount.closeAllDatabases handles cleanup on shutdown.
    const managedDb = await mount.openDatabase(COLLAB_DB_CONFIG, dataDbPath.id);
    const { doc: ydoc } = loadYjsState(managedDb);

    return { json: readEigendocFromDoc(ydoc), mediaByName: await listDocumentMedia(mount, drivePath) };
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
