import type { JSONContent } from '@tiptap/core';
import type { Schema } from '@tiptap/pm/model';
import { prosemirrorJSONToYDoc, yXmlFragmentToProsemirrorJSON } from '@tiptap/y-tiptap';
import type { DrivePath } from '@workspace/lib/types/drive';
import * as Y from 'yjs';
import { COLLAB_DB_CONFIG } from '../collab/db-config';
import { loadYjsState } from '../collab/yjs-loader';
import type { Mount } from '../mount';

export type EigendocContent = {
    json: JSONContent;
    mediaByName: Map<string, DrivePath>;
};

export async function readEigendocContent(mount: Mount, drivePath: DrivePath): Promise<EigendocContent> {
    const dataDbPath = await mount.getChildByName(drivePath.id, 'data.db');
    if (!dataDbPath) throw new Error('eigendoc data.db missing');

    // Open (or reuse) the database — don't close it, as a collab session may share
    // this instance. Mount.closeAllDatabases handles cleanup on shutdown.
    const managedDb = await mount.openDatabase(COLLAB_DB_CONFIG, dataDbPath.id);
    const { doc: ydoc } = loadYjsState(managedDb);
    const json = yXmlFragmentToProsemirrorJSON(ydoc.getXmlFragment('default'));

    const mediaFolder = await mount.getChildByName(drivePath.id, 'media');
    const mediaChildren = mediaFolder ? await mount.listFolder(mediaFolder.id) : [];
    const mediaByName = new Map(mediaChildren.map((f) => [f.name, f]));

    return { json, mediaByName };
}

export function writeEigendocToYjs(doc: Y.Doc, json: JSONContent, schema: Schema): void {
    doc.transact(() => {
        const fragment = doc.getXmlFragment('default');
        if (fragment.length > 0) fragment.delete(0, fragment.length);
    });

    const tempDoc = prosemirrorJSONToYDoc(schema, json, 'default');
    Y.applyUpdate(doc, Y.encodeStateAsUpdate(tempDoc));
    tempDoc.destroy();
}
