// The collab documents that are open in one Drive, such as docs that someone edits right now. It opens
// each document once, however many people connect, and closes it again. Drive holds one and passes every
// open and close through it, and it refuses an open once the drive or the document's mount is closing.

import { isCollabType } from '@workspace/lib/types/drive';
import type { AsyncSingleton } from '../../utils/singleton';
import { createAsyncSingleton } from '../../utils/singleton';
import { CollabDocument } from '../collab/collab-document';
import { ApiError } from '../core';
import type { Mount } from '../mount';
import type { Drive } from './drive';

export class CollabRegistry {
    private readonly documents = new Map<string, AsyncSingleton<CollabDocument>>();
    // Set by destructAll. A document opened after it would never be destructed, and closing the mount
    // next would close its database under it.
    private destructed = false;
    // The mounts destructMount swept, for the same reason. A mount that comes back is a new Mount, so
    // its documents open again.
    private readonly closedMounts = new WeakSet<Mount>();

    public constructor(private readonly ownerId: string) {}

    public has(mountId: string, pathId: string): boolean {
        return this.documents.has(this.key(mountId, pathId));
    }

    public async get(drive: Drive, mount: Mount, pathId: string): Promise<CollabDocument> {
        if (this.destructed) throw new ApiError(503, 'Drive is shutting down');
        if (this.closedMounts.has(mount)) throw new ApiError(503, 'Mount is closing');
        const key = this.key(mount.id, pathId);
        let getter = this.documents.get(key);
        if (!getter) {
            getter = createAsyncSingleton(async () => {
                try {
                    const path = await mount.getActivePath(pathId);
                    if (!isCollabType(path.type)) {
                        throw new ApiError(404, 'Document not found');
                    }
                    return await CollabDocument.open(drive, path);
                } catch (err) {
                    // A load that failed opened nothing. Only this entry goes, never one a newer get made.
                    if (this.documents.get(key) === getter) this.documents.delete(key);
                    throw err;
                }
            });
            this.documents.set(key, getter);
        }
        return getter();
    }

    public async close(mount: Mount, pathId: string, opts?: { skipFinalSnapshot?: boolean }): Promise<void> {
        const key = this.key(mount.id, pathId);
        const documentFn = this.documents.get(key);
        if (!documentFn) return;
        // The entry goes before the close starts, so a get() meanwhile builds a new document. The
        // closing one would never answer the client's sync, and the client would hang.
        this.documents.delete(key);
        // A load that failed, such as one that met the trash it raced, opened nothing. Its caller has the error.
        const doc = await documentFn().catch(() => null);
        if (!doc) return;
        doc.destruct();
        console.log(`[collab] teardown path=${pathId}`);
        // When the document was opened again meanwhile, the new one owns data.db, so it stays open.
        if (!this.documents.has(key)) {
            await mount.closeDatabase(doc.dataDbPathId, opts);
        }
    }

    // Destructs every open document. The caller closes the mount databases afterwards, because a
    // document may still write its last changes while it is destructed.
    public async destructAll(): Promise<void> {
        this.destructed = true;
        await this.destructWhere(() => true);
    }

    // Destructs the open documents of one mount, such as before the mount gets new storage or is
    // turned off. The caller closes the mount databases afterwards, the same as after destructAll.
    public async destructMount(mount: Mount): Promise<void> {
        this.closedMounts.add(mount);
        const prefix = this.key(mount.id, '');
        await this.destructWhere((key) => key.startsWith(prefix));
    }

    private async destructWhere(matches: (key: string) => boolean): Promise<void> {
        for (const [key, getter] of [...this.documents]) {
            if (!matches(key)) continue;
            this.documents.delete(key);
            // A load that failed, or that this teardown stopped, opened nothing. Its caller has the error.
            const doc = await getter().catch(() => null);
            if (!doc) continue;
            try {
                doc.destruct();
            } catch (error) {
                console.error(`Failed to close document ${key}:`, error);
            }
        }
    }

    private key(mountId: string, pathId: string): string {
        return `${this.ownerId}.${mountId}.${pathId}`;
    }
}
