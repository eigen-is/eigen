// The collab documents that are open in one Drive, such as docs that someone edits right now. It opens
// each document once, however many people connect, and closes it again. When sharing changes, it
// closes the connections of people who may no longer read.

import { isCollabType, isContainerType } from '@workspace/lib/types/drive';
import { createAsyncSingleton } from '../../utils/singleton';
import CollabDocument from '../collab/collabDocument';
import { ApiError } from '../core';
import type { Mount } from '../mount';
import type { Drive } from './drive';
export class CollabRegistry {
    private documents = new Map<string, () => Promise<CollabDocument>>();
    // Set by destructAll. A document opened after it would never be destructed, and closing the mount
    // next would close its database under it.
    private destructed = false;

    public constructor(private ownerId: string) {}

    private key(mountId: string, pathId: string): string {
        return `${this.ownerId}.${mountId}.${pathId}`;
    }

    public has(mountId: string, pathId: string): boolean {
        return this.documents.has(this.key(mountId, pathId));
    }

    public async get(drive: Drive, mount: Mount, pathId: string): Promise<CollabDocument> {
        if (this.destructed) throw new ApiError(503, 'Drive is shutting down');
        const key = this.key(mount.id, pathId);
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
        for (const [key, getter] of this.documents) {
            // A load that failed, or that this teardown stopped, opened nothing. Its caller has the error.
            const doc = await getter().catch(() => null);
            if (!doc) continue;
            try {
                doc.destruct();
            } catch (error) {
                console.error(`Failed to close document ${key}:`, error);
            }
        }
        this.documents.clear();
    }
}
