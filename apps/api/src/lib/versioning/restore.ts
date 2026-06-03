import { restoreYjsDoc } from '@workspace/lib/core/collab/yjs-utils';
import { DRIVE_TYPE_DOC, type DrivePath, isCollabType } from '@workspace/lib/types/drive';
import { readYjsStateFromFile } from '../collab/yjs-loader';
import { ApiError } from '../core';
import type Drive from '../drive/drive';
import type { Mount } from '../mount/mount';
import { DEFAULT_RETENTION, type RetentionPolicy } from './retention';

export async function restoreContainer(
    drive: Drive,
    mount: Mount,
    container: DrivePath,
    snapshotName: string,
    policy: RetentionPolicy = DEFAULT_RETENTION,
): Promise<void> {
    await mount.withPathLock(container.id, async () => {
        // Look up the target up front so the pre-restore snapshot's pruning
        // can preserve it — otherwise the new pre-restore would push the
        // target out of its retention slot and the restore step 404s.
        const versions = await mount.getChildByName(container.id, 'versions');
        if (!versions) throw new ApiError(404, 'No versions folder');
        const target = await mount.getChildByName(versions.id, snapshotName);
        if (!target) throw new ApiError(404, `Snapshot ${snapshotName} not found`);

        // 1. Pre-restore snapshot so the operation is reversible.
        await mount.snapshotContainerDataDb(container.id, policy, target.id);

        // Sheets/slides/stickies store state in Y.Map / Y.Array — restoreYjsDoc
        // can clear and re-insert from the snapshot, riding the existing Yjs
        // broadcast so every connected editor converges live, no disconnect.
        //
        // Docs use Y.XmlFragment (Tiptap/ProseMirror), which can't round-trip
        // through restoreYjsDoc's Map/Array surgery — `XmlElement.toJSON()`
        // returns serialized strings rather than live Y types, and pushing
        // those back corrupts the fragment. Until we add an XmlFragment-aware
        // path, docs fall through to file-level restore; the client reloads
        // the page to discard its in-memory Y.Doc and pick up the restored
        // state cleanly. Chat (no Yjs) takes the same file-level path —
        // TanStack Query refetches the messages.
        const useSurgery = isCollabType(container.type) && container.type !== DRIVE_TYPE_DOC;
        if (useSurgery) {
            await restoreYjsContainer(drive, mount, container.id, target);
        } else {
            await evictContainer(drive, mount, container.id);
            await mount.restoreContainerDataDb(container.id, snapshotName);
        }
    });
}

// Evict every in-process artefact of an open container: the collab singleton
// (if cached in Drive.documents) and the canonical managed DBs (`data.db`,
// `comments.db`). Chat does NOT have a singleton — Drive.getChat returns a
// fresh ChatRoom per call — so closing the managed DB is sufficient.
// Caller MUST hold withPathLock to serialise concurrent restore/save.
//
// skipFinalSnapshot: we already took the pre-restore snapshot before calling
// here; the close-time forceSnapshot would be fire-and-forget, run with no
// preserve hint, and could prune the target between
// restoreContainerDataDb's lookup and copy.
async function evictContainer(drive: Drive, mount: Mount, containerId: string): Promise<void> {
    await drive.closeCollabDocument(mount.id, containerId, { skipFinalSnapshot: true });
    // Named explicitly so a future eigendoc type with extra sidecar DBs has
    // to opt in here on purpose, not by directory walk.
    for (const name of ['data.db', 'comments.db']) {
        const child = await mount.getChildByName(containerId, name);
        if (!child) continue;
        await mount
            .closeDatabase(child.id, { skipFinalSnapshot: true })
            .catch((err) => console.warn(`[restore] evictContainer: closeDatabase(${name}) failed:`, err));
    }
}

async function restoreYjsContainer(
    drive: Drive,
    mount: Mount,
    containerId: string,
    snapshotPath: DrivePath,
): Promise<void> {
    // Read the snapshot's Yjs state directly off disk — no migrations,
    // no cache pollution in Mount.documentDbs.
    const snapshotLocalPath = await mount.resolveLocalPath(snapshotPath.id);
    const snapshotState = readYjsStateFromFile(snapshotLocalPath, `restore:${snapshotPath.name}`);

    // Open the live CollabDocument (creates the singleton if no one is
    // connected). restoreYjsDoc emits a single Yjs update that the doc's
    // existing 'update' handler broadcasts to every WebSocket in
    // this.connections and persists via DbProvider — so disconnected
    // sessions also catch up via the next sync handshake.
    const collabDoc = await drive.getCollabDocument(mount.id, containerId);
    let updates = 0;
    let bytes = 0;
    const tap = (update: Uint8Array) => {
        updates += 1;
        bytes += update.byteLength;
    };
    collabDoc.doc.on('update', tap);
    try {
        restoreYjsDoc(collabDoc.doc, snapshotState);
    } finally {
        collabDoc.doc.off('update', tap);
    }
    console.log(
        `[restore] yjs surgery on ${snapshotPath.name}: ${updates} update(s), ${bytes}B → ${collabDoc.connectionCount} client(s)`,
    );
}
