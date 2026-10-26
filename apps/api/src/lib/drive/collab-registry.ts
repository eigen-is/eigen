// The collab documents that are open in one Drive, such as docs that someone edits right now. It opens
// each document once, however many people connect, and closes it again. When sharing changes, it
// closes the connections of people who may no longer read.

import { isCollabType, isContainerType } from '@workspace/lib/types/drive';
import { createAsyncSingleton } from '../../utils/singleton';
import { CollabDocument } from '../collab/collab-document';
import { ApiError } from '../core';
import type { Mount } from '../mount';
import type { Drive } from './drive';

export class CollabRegistry {
    private documents = new Map<string, () => Promise<CollabDocument>>();
    // Set by destructAll. A document opened after it would never be destructed, and closing the mount
    // next would close its database under it.
    private destructed = false;
    // The mounts destructMount swept, for the same reason. A mount that comes back is a new Mount, so
    // its documents open again.
    private readonly closedMounts = new WeakSet<Mount>();
    // The keys of a path that is moving to the trash, and of everything under it. The trash closes their
    // databases before it marks them trashed, so a document opened in between would lose its edits. A
    // key counts the trashes that guard it, because two trashes of nested paths can overlap.
    private readonly trashing = new Map<string, number>();

    public constructor(private ownerId: string) {}

    private key(mountId: string, pathId: string): string {
        return `${this.ownerId}.${mountId}.${pathId}`;
    }

    public has(mountId: string, pathId: string): boolean {
        return this.documents.has(this.key(mountId, pathId));
    }

    public async get(drive: Drive, mount: Mount, pathId: string): Promise<CollabDocument> {
        if (this.destructed) throw new ApiError(503, 'Drive is shutting down');
        if (this.closedMounts.has(mount)) throw new ApiError(503, 'Mount is closing');
        const key = this.key(mount.id, pathId);
        if (this.trashing.has(key)) throw new ApiError(503, 'Document is moving to the trash');
        let getter = this.documents.get(key);
        if (!getter) {
            getter = createAsyncSingleton(async () => {
                try {
                    const path = await mount.getActivePath(pathId);
                    if (!isCollabType(path.type)) {
                        throw new ApiError(404, 'Document not found');
                    }
                    const document = new CollabDocument(drive, path);
                    return await document.init();
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
        const doc = await documentFn();
        doc.destruct();
        console.log(`[collab] teardown path=${pathId}`);
        // When the document was opened again meanwhile, the new one owns data.db, so it stays open.
        if (doc.dataDbPathId && !this.documents.has(key)) {
            await mount.closeDatabase(doc.dataDbPathId, opts);
        }
    }

    // Whether the path is on its way to the trash, on its own or with a folder above it.
    public isTrashing(mount: Mount, pathId: string): boolean {
        return this.trashing.has(this.key(mount.id, pathId));
    }

    // Runs a trash of the path and refuses every open at or below it until the trash is done. The
    // refused socket tries again, and by then the path is in the trash, so it gets a 404.
    public async whileTrashing(mount: Mount, pathId: string, trash: () => Promise<void>): Promise<void> {
        const keys = [pathId, ...mount.collectDescendantIds(pathId)].map((id) => this.key(mount.id, id));
        for (const key of keys) this.trashing.set(key, (this.trashing.get(key) ?? 0) + 1);
        try {
            await trash();
            // A document can move into the folder after the keys above were read. The trash closed its
            // database with the rest, so the document closes now and stops taking edits it can't save.
            for (const id of [pathId, ...mount.collectDescendantIds(pathId)]) {
                if (this.has(mount.id, id)) await this.close(mount, id, { skipFinalSnapshot: true });
            }
        } finally {
            for (const key of keys) {
                const count = this.trashing.get(key) ?? 0;
                if (count > 1) this.trashing.set(key, count - 1);
                else this.trashing.delete(key);
            }
        }
    }

    // Checks read access again for every open document at or below the path. Read access comes from
    // the whole chain of folders, so a check per connection also catches a share taken away from a
    // folder above the document. Comparing the removed ACL entries would miss that.
    public async enforceReadAccessBelow(mount: Mount, pathId: string): Promise<void> {
        const path = await mount.getPath(pathId);
        if (!path) return;

        if (isCollabType(path.type)) {
            // Only an open document has connections to check.
            const getter = this.documents.get(this.key(mount.id, pathId));
            if (!getter) return;
            try {
                const doc = await getter();
                await doc.enforceReadAccess();
            } catch (error) {
                console.error(`Failed to enforce read access on ${pathId}:`, error);
            }
        } else if (isContainerType(path.type)) {
            const children = await mount.listFolderAll(pathId);
            for (const child of children) {
                await this.enforceReadAccessBelow(mount, child.id);
            }
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
}
