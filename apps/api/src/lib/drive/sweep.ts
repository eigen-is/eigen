// The media sweep. Once a document's last tab has closed, it deletes the files in the document's media folder that
// nothing names any more, such as an image deleted before every version that is still kept. A file stays while the
// current state or a saved version names it, or while it is younger than three days. A linger close starts it, at most
// once a day per document. A change while it reads waits for the next close, and a failure for the next day, so a
// sweep can keep a file too long but never deletes one in use.

import type { DrivePath } from '@workspace/lib/types/drive';
import { DRIVE_TYPE_FILE, isCollabType } from '@workspace/lib/types/drive';
import type { Snapshot } from '@workspace/lib/types/versioning';
import { compressBlob } from '../collab/blob-codec';
import type { YjsStatePayload } from '../collab/yjs-loader';
import { readYjsStatePayloadFromFile } from '../collab/yjs-loader';
import { REFERENCE_READER_VERSION } from '../document/references';
import { toTransferableBuffer } from '../document/transform/protocol';
import { runDocumentReferences } from '../document/transform/run-transform';
import type { Mount } from '../mount';
import { foldName } from '../mount/names';
import { getVersionReferences, putVersionReferences } from '../mount/version-references';
import { withSvgSiblings } from '../preview/svg-media-inline';
import { listVersions } from '../versioning/list';
import { DAY_MS, HOUR_MS } from '../versioning/retention';
import type { Drive } from './drive';

// A file this young stays, whatever names it. An upload lands in media/ before the edit that names it reaches the
// server, and a tab that was offline may still hold such an edit.
const MEDIA_GRACE_MS = 72 * HOUR_MS;

// When each document's last sweep ended, by owner, mount and path. It lives in memory, so a restart forgets it, which
// costs one extra sweep.
const sweptAt = new Map<string, number>();

export function isSweepDue(path: DrivePath): boolean {
    const at = sweptAt.get(sweepKey(path));
    return at === undefined || Date.now() - at >= DAY_MS;
}

// Closes a lingering document and then sweeps it. The hold on the Home comes first, because the close lets go of the
// hold the lingering document kept, and an idle Home would close before the sweep began. `state` is the document as
// it closes, encoded before the close destroys it. It resolves with the close, and the sweep goes on in the background.
export function sweepAfterClose(
    drive: Drive,
    path: DrivePath,
    state: Uint8Array,
    close: () => Promise<void>,
): Promise<void> {
    const releaseHome = drive.holdHome();
    const closed = close();
    closed
        .then(() => sweepDocument(drive, path, state))
        .catch((error: unknown) => {
            console.warn(`[sweep] skipped ${path.id}:`, error instanceof Error ? error.message : error);
        })
        .finally(releaseHome);
    return closed;
}

// Reads everything first, outside any lock: the names in the current state and in every saved version. Then, under
// the document's lock, it deletes only if nothing changed while it read.
export async function sweepDocument(drive: Drive, container: DrivePath, state: Uint8Array): Promise<void> {
    if (!isCollabType(container.type)) return;
    // A change while it read leaves the document due, so its next close tries again. Every other end marks the
    // document swept for the day, a failure included.
    let changed = false;
    try {
        const documentType = container.type;
        const { mount } = await drive.resolveFile(container.mountId, container.id);
        if (isBusy(drive, mount, container.id)) {
            changed = true;
            return;
        }
        const read = await readFence(mount, container.id);

        // The current state goes compressed, as a stored version does. Then each version is read once, and again only
        // when the reader changed. Every read is a job of its own, and a version's row is written as soon as its job
        // returns. So memory and the child's time stay bounded to one version, and a failure keeps the work done.
        const current = { snapshot: null, updates: [{ id: 0, data: toTransferableBuffer(compressBlob(state)) }] };
        const named = [await runDocumentReferences({ documentType, source: current }, { priority: 'background' })];
        const rows = getVersionReferences(
            mount,
            read.versions.map((version) => version.id),
        ).filter((row) => row.readerVersion >= REFERENCE_READER_VERSION);
        named.push(...rows.map((row) => row.names));
        const known = new Set(rows.map((row) => row.versionPathId));
        for (const version of read.versions) {
            if (known.has(version.id)) continue;
            // A version is read from a temp copy of its own, still compressed.
            const tempId = crypto.randomUUID();
            let source: YjsStatePayload;
            try {
                source = readYjsStatePayloadFromFile(await mount.downloadToTemp(version.id, tempId));
            } finally {
                await mount.cleanupTemp(tempId);
            }
            const names = await runDocumentReferences({ documentType, source }, { priority: 'background' });
            named.push(names);
            putVersionReferences(mount, [
                { versionPathId: version.id, readerVersion: REFERENCE_READER_VERSION, names },
            ]);
        }

        // A name matches its file as getChildByName finds it, whatever its case or Unicode form.
        const media = await mount.getChildByName(container.id, 'media');
        const kept = media
            ? await withSvgSiblings(
                  mount,
                  media.id,
                  named.flatMap((names) => names.media),
              )
            : [];
        const keptNames = new Set([...kept].map(foldName));

        const deleted = await mount.withPathLock(container.id, async () => {
            const row = await mount.getPath(container.id);
            if (!row || row.trashedAt || isBusy(drive, mount, container.id)) return null;
            if ((await readFence(mount, container.id)).fence !== read.fence) return null;
            const cutoff = Date.now() - MEDIA_GRACE_MS;
            const unnamed = (media ? await mount.listFolder(media.id) : []).filter(
                (file) =>
                    file.type === DRIVE_TYPE_FILE &&
                    !keptNames.has(foldName(file.name)) &&
                    file.createdAt.getTime() <= cutoff,
            );
            await Promise.all(unnamed.map((file) => mount.deletePath(file.id)));
            return unnamed;
        });
        if (!deleted) {
            changed = true;
            return;
        }
        if (deleted.length === 0) return;
        const freed = deleted.reduce((sum, file) => sum + file.size, 0);
        console.log(`[sweep] ${container.id}: deleted ${deleted.length} media files, freed ${freed} bytes`);
    } finally {
        if (!changed) {
            const now = Date.now();
            for (const [key, at] of sweptAt) if (now - at >= DAY_MS) sweptAt.delete(key);
            sweptAt.set(sweepKey(container), now);
        }
    }
}

function sweepKey(path: DrivePath): string {
    return `${path.ownerId}.${path.mountId}.${path.id}`;
}

// A document someone opened again, one on its way to the trash, one a restore puts back and a mount that closes are
// left alone.
function isBusy(drive: Drive, mount: Mount, containerId: string): boolean {
    return (
        mount.closing ||
        drive.hasCollabDocument(mount.id, containerId) ||
        drive.isTrashing(mount.id, containerId) ||
        drive.isRestoring(mount.id, containerId)
    );
}

// What a change to the document while the sweep read would move: the data.db row, which every save stamps, and the
// list of versions, which a save, a prune or a restore changes.
async function readFence(mount: Mount, containerId: string): Promise<{ versions: Snapshot[]; fence: string }> {
    const [dataDb, versions] = await Promise.all([
        mount.getChildByName(containerId, 'data.db'),
        listVersions(mount, containerId),
    ]);
    const fence = JSON.stringify([dataDb?.size, dataDb?.updatedAt.getTime(), versions.map((version) => version.id)]);
    return { versions, fence };
}
