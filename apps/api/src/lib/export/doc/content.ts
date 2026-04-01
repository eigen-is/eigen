import type { JSONContent } from '@tiptap/core';
import { yXmlFragmentToProsemirrorJSON } from '@tiptap/y-tiptap';
import type { DrivePath } from '@workspace/lib/types/drive';
import { COLLAB_DB_CONFIG } from '../../collab/db-config';
import { loadYjsState } from '../../collab/yjs-loader';
import type { Mount } from '../../mount';

export type MediaFile = {
    pathId: string;
    name: string;
    mimeType: string;
};

export type EigendocContent = {
    pmJson: JSONContent;
    mediaByName: Map<string, MediaFile>;
};

export async function loadEigendocContent(mount: Mount, drivePath: DrivePath): Promise<EigendocContent | null> {
    const dataDbPath = await mount.getChildByName(drivePath.id, 'data.db');
    if (!dataDbPath) return null;

    // Open (or reuse) the database — don't close it, as a collab session may share
    // this instance. Mount.closeAllDatabases handles cleanup on shutdown.
    const managedDb = await mount.openDatabase(COLLAB_DB_CONFIG, dataDbPath.id);
    const ydoc = loadYjsState(managedDb);
    const pmJson = yXmlFragmentToProsemirrorJSON(ydoc.getXmlFragment('default'));

    // Build media name -> file lookup
    const mediaFolder = await mount.getChildByName(drivePath.id, 'media');
    const mediaChildren = mediaFolder ? await mount.listFolder(mediaFolder.id) : [];
    const mediaByName = new Map(
        mediaChildren.map((f) => [f.name, { pathId: f.id, name: f.name, mimeType: f.mimeType }]),
    );

    return { pmJson, mediaByName };
}
