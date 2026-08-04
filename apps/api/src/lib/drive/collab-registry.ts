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

    constructor(private ownerId: string) {}

    private key(mountId: string, pathId: string): string {
        return `${this.ownerId}.${mountId}.${pathId}`;
    }

    has(mountId: string, pathId: string): boolean {
        return this.documents.has(this.key(mountId, pathId));
    }

    async get(drive: Drive, mount: Mount, pathId: string): Promise<CollabDocument> {
        const key = this.key(mount.id, pathId);
        if (!this.documents.has(key)) {
            this.documents.set(
                key,
                createAsyncSingleton(async () => {
                    const path = await mount.getActivePath(pathId);
                    if (!isCollabType(path.type)) {
                        throw new ApiError(404, 'Document not found');
                    }
                    const document = new CollabDocument(drive, path);
                    return (await document.init()) as CollabDocument;
                }),
            );
        }
        return (await this.documents.get(key)!()) as CollabDocument;
    }

    async close(mount: Mount, pathId: string, opts?: { skipFinalSnapshot?: boolean }): Promise<void> {
        const key = this.key(mount.id, pathId);
        const documentFn = this.documents.get(key);
        if (!documentFn) return;
        // Delete BEFORE the async destruct so a concurrent get() builds a fresh singleton
        // instead of receiving the doc that is closing (a closing doc never sends
        // sync-step-1, stalling the client). Mirrors Mount.closeDatabase's delete-before-close.
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
        for (const [key, getter] of this.documents) {
            try {
                const doc = await getter();
                doc.destruct();
            } catch (error) {
                console.error(`Failed to close document ${key}:`, error);
            }
        }
        this.documents.clear();
    }
}
