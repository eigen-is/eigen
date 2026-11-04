// The media sweep. Once a document's last tab has closed, it deletes the files in the document's media folder that
// nothing names any more, such as an image deleted before every version that is still kept. A file stays while the
// current state or a saved version names it, or while it is younger than three days. A linger close starts it, at most
// once a day per document. Any failure skips the document until a later close, so a sweep can keep a file too long
// but never deletes one in use.

import type { DrivePath } from '@workspace/lib/types/drive';
import { DRIVE_TYPE_FILE, isCollabType } from '@workspace/lib/types/drive';
import type { Snapshot } from '@workspace/lib/types/versioning';
import type { YjsStatePayload } from '../collab/yjs-loader';
import { readYjsStatePayloadFromFile } from '../collab/yjs-loader';
import type { DocumentReferences } from '../document/references';
import { REFERENCE_READER_VERSION, REFERENCED_TYPE_BY_DRIVE_TYPE } from '../document/references';
import type { ReferencesJob } from '../document/transform/protocol';
import { inputBytesOf, toTransferableBuffer } from '../document/transform/protocol';
import { runDocumentReferences } from '../document/transform/run-transform';
import type { Mount } from '../mount';
import { getVersionReferences, putVersionReferences } from '../mount/version-references';
import { MAX_DECOMPRESSED_BYTES } from '../ooxml/zip';
import { withSvgSiblings } from '../preview/svg-media-inline';
import { listVersions } from '../versioning/list';
import { DAY_MS, HOUR_MS } from '../versioning/retention';
import type { Drive } from './drive';

// A file this young stays, whatever names it. An upload lands in media/ before the edit that names it reaches the
// server, and a tab that was offline may still hold such an edit.
const MEDIA_GRACE_MS = 72 * HOUR_MS;

// When each document's last sweep finished, per Drive. It lives in memory, so a restart or a home that unloads forgets
// it, which costs one extra sweep.
const sweptAt = new WeakMap<Drive, Map<string, number>>();

export function isSweepDue(drive: Drive, path: DrivePath): boolean {
    const at = sweptAt.get(drive)?.get(sweepKey(path));
    return at === undefined || Date.now() - at >= DAY_MS;
}

// Starts the sweep of a document whose linger close is under way. It holds the Home from now, because the close lets
// go of the hold the lingering document kept, and an idle Home would close before the sweep began. `state` is the
// document as it closed, encoded before the close destroyed it.
export function sweepAfterClose(drive: Drive, path: DrivePath, state: Uint8Array, closed: Promise<void>): void {
    drive
        .withHomeHeld(async () => {
            await closed;
            await sweepDocument(drive, path, state);
        })
        .catch((error: unknown) => {
            console.warn(`[sweep] skipped ${path.id}:`, error instanceof Error ? error.message : error);
        });
}

// Reads everything first, outside any lock: the names in the current state and in every saved version. Then, under
// the document's lock, it deletes only if nothing changed while it read.
export async function sweepDocument(drive: Drive, container: DrivePath, state: Uint8Array): Promise<void> {
    if (!isCollabType(container.type)) return;
    const documentType = REFERENCED_TYPE_BY_DRIVE_TYPE[container.type];
    const { mount } = await drive.resolveFile(container.mountId, container.id);
    if (isBusy(drive, mount, container.id)) return;
    const read = await readFence(mount, container.id);

    // Each version is read once, and again only when the reader changed. A row is written as soon as its chunk
    // returns, so the work done survives a failure later in the sweep.
    const rows = getVersionReferences(
        mount,
        read.versions.map((version) => version.id),
    ).filter((row) => row.readerVersion >= REFERENCE_READER_VERSION);
    const named: DocumentReferences[] = rows.map((row) => row.names);
    const known = new Set(rows.map((row) => row.versionPathId));

    // The states go to the transform process in chunks under its copy cap, the current state in the first one. Each
    // document's version id goes beside it, null for the current state.
    let ids: (string | null)[] = [null];
    let documents: ReferencesJob['documents'] = [
        { documentType, source: { snapshot: null, updates: [{ id: 0, data: toTransferableBuffer(state) }] } },
    ];
    const readChunk = async (): Promise<void> => {
        const references = await runDocumentReferences(documents, { priority: 'background' });
        named.push(...references);
        putVersionReferences(
            mount,
            references.flatMap((names, index) => {
                const versionPathId = ids[index];
                return versionPathId ? [{ versionPathId, readerVersion: REFERENCE_READER_VERSION, names }] : [];
            }),
        );
        ids = [];
        documents = [];
    };
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
        const document = { documentType, source };
        const bytes = inputBytesOf({ kind: 'references', documents: [...documents, document] });
        if (documents.length > 0 && bytes > MAX_DECOMPRESSED_BYTES) await readChunk();
        ids.push(version.id);
        documents.push(document);
    }
    if (documents.length > 0) await readChunk();

    const media = await mount.getChildByName(container.id, 'media');
    const keptMedia = media
        ? await withSvgSiblings(
              mount,
              media.id,
              named.flatMap((names) => names.media),
          )
        : new Set<string>();

    const deleted = await mount.withPathLock(container.id, async () => {
        const row = await mount.getPath(container.id);
        if (!row || row.trashedAt || isBusy(drive, mount, container.id)) return null;
        if ((await readFence(mount, container.id)).fence !== read.fence) return null;
        const cutoff = Date.now() - MEDIA_GRACE_MS;
        const unnamed = (media ? await mount.listFolder(media.id) : []).filter(
            (file) => file.type === DRIVE_TYPE_FILE && !keptMedia.has(file.name) && file.createdAt.getTime() <= cutoff,
        );
        for (const file of unnamed) await mount.deletePath(file.id);
        return unnamed;
    });
    if (!deleted) return;
    const marks = sweptAt.get(drive) ?? new Map<string, number>();
    sweptAt.set(drive, marks.set(sweepKey(container), Date.now()));
    const freed = deleted.reduce((sum, file) => sum + file.size, 0);
    console.log(`[sweep] ${container.id}: deleted ${deleted.length} media files, freed ${freed} bytes`);
}

function sweepKey(path: DrivePath): string {
    return `${path.mountId}.${path.id}`;
}

// A document someone opened again, one on its way to the trash and a mount that closes are left alone.
function isBusy(drive: Drive, mount: Mount, containerId: string): boolean {
    return mount.closing || drive.hasCollabDocument(mount.id, containerId) || drive.isTrashing(mount.id, containerId);
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
