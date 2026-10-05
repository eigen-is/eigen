import { isCollabType, isContainerType } from '@workspace/lib/types/drive';
import { createAsyncSingleton } from '../../utils/singleton';
import CollabDocument from '../collab/collabDocument';
import { ApiError } from '../core';
import type { Mount } from '../mount';
import type Drive from './drive';

// Registry of open collab documents for a single Drive (one per Home), keyed by
// owner.mount.path. Owns the open/close lifecycle as a state-owning field on Drive
// (the lock-manager precedent); doc contents persist through the mount's data.db.
export class CollabRegistry {
    private documents = new Map<string, () => Promise<CollabDocument>>();
    // Set by destructAll: a document opened after the sweep would never be destructed, and the mount
    // teardown that follows would close its db under it.
    private destructed = false;

    constructor(private ownerId: string) {}

    private key(mountId: string, pathId: string): string {
        return `${this.ownerId}.${mountId}.${pathId}`;
    }

    has(mountId: string, pathId: string): boolean {
        return this.documents.has(this.key(mountId, pathId));
    }

    async get(drive: Drive, mount: Mount, pathId: string): Promise<CollabDocument> {
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
                    // A failed load is not an open document: delete only our own entry, never a newer get's.
                    if (this.documents.get(key) === getter) this.documents.delete(key);
                    throw err;
                }
            });
            this.documents.set(key, getter);
        }
        return getter();
    }

    async close(mount: Mount, pathId: string, opts?: { skipFinalSnapshot?: boolean }): Promise<void> {
        const key = this.key(mount.id, pathId);
        const documentFn = this.documents.get(key);
        if (!documentFn) return;
        // Remove from the registry before the async close so a concurrent get() builds fresh
        // instead of receiving the doc that is closing (it never sends sync-step-1, stalling the client).
        this.documents.delete(key);
        const doc = await documentFn();
        doc.destruct();
        console.log(`[collab] teardown path=${pathId}`);
        // Only tear down the shared data.db if no concurrent reopen re-registered this doc — the
        // reopened doc now owns the db lifecycle.
        if (doc.dataDbPathId && !this.documents.has(key)) {
            await mount.closeDatabase(doc.dataDbPathId, opts);
        }
    }

    // Re-check read on every OPEN collab doc at or below `pathId` (mirrors trash.ts's
    // closeCollabDocumentsRecursively walk). Re-checking canRead per connection — not
    // diffing removed ACL entries — is what makes revoking a *folder* share cascade to
    // docs nested inside it, since read is inherited from the whole ancestor chain.
    async enforceReadAccessBelow(mount: Mount, pathId: string): Promise<void> {
        const path = await mount.getPath(pathId);
        if (!path) return;

        if (isCollabType(path.type)) {
            // Only open docs hold live connections; skip closed ones to keep this cheap.
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

    // Destruct every open Yjs doc; the caller closes the mount databases afterwards
    // (Yjs may flush pending changes during destruct(), which needs the db still open).
    async destructAll(): Promise<void> {
        this.destructed = true;
        for (const [key, getter] of this.documents) {
            // A load this teardown aborted, or one that failed, opened nothing; its caller has the error.
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
