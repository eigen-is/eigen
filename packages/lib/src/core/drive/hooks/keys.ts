import type { QueryClient } from '@tanstack/react-query';
import { DEFAULT_MOUNT_ID } from '@workspace/lib/types/mount';
import { collabKeys } from '../../collab/hooks/keys';
import { invalidateHomeSize } from '../../home';

export { DEFAULT_MOUNT_ID };

// Define query keys for reuse
export const driveKeys = {
    all: ['drive'] as const,
    owner: (ownerId: string) => [...driveKeys.all, ownerId] as const,
    mounts: (ownerId: string) => [...driveKeys.owner(ownerId), 'mounts'] as const,
    root: (ownerId: string, mountId: string) => [...driveKeys.owner(ownerId), 'root', mountId] as const,
    folders: (ownerId: string) => [...driveKeys.owner(ownerId), 'folder'] as const,
    folder: (ownerId: string, mountId: string, pathId: string) =>
        [...driveKeys.folders(ownerId), mountId, pathId] as const,
    mimeTypes: (ownerId: string) => [...driveKeys.owner(ownerId), 'mime'] as const,
    mime: (ownerId: string, mimeType: string) => [...driveKeys.mimeTypes(ownerId), mimeType] as const,
    // Aggregate (personal + every team the caller belongs to) mime listing. Deliberately owner-less
    // (always "the current user's everything"); the mimeAllTypes prefix enables form-agnostic invalidation.
    mimeAllTypes: () => [...driveKeys.all, 'mimeAll'] as const,
    mimeAll: (mimeType: string) => [...driveKeys.mimeAllTypes(), mimeType] as const,
    mountMime: (ownerId: string, mountId: string, mimeType: string) =>
        [...driveKeys.mimeTypes(ownerId), mountId, mimeType] as const,
    paths: (ownerId: string) => [...driveKeys.owner(ownerId), 'path'] as const,
    path: (ownerId: string, mountId: string, pathId: string) => [...driveKeys.paths(ownerId), mountId, pathId] as const,
    breadcrumb: (ownerId: string, mountId: string, pathId: string) =>
        [...driveKeys.path(ownerId, mountId, pathId), 'breadcrumb'] as const,
    permissions: (ownerId: string, mountId: string, pathId: string) =>
        [...driveKeys.owner(ownerId), 'permissions', mountId, pathId] as const,
    shared: (ownerId: string, to: 'by-me' | 'with-me') => [...driveKeys.owner(ownerId), 'shared', to] as const,
    textPreviews: (ownerId: string) => [...driveKeys.owner(ownerId), 'text-preview'] as const,
    textPreview: (ownerId: string, mountId: string, pathId: string, updatedAt?: Date) =>
        [...driveKeys.textPreviews(ownerId), mountId, pathId, updatedAt?.getTime()] as const,
    // Owner-scoped prefix for the effective-members family (every mount+path under one owner).
    // invalidateEffectiveMembers drops the whole family on an ancestor ACL change.
    effectiveMembersForOwner: (ownerId: string) => [...driveKeys.owner(ownerId), 'effective-members'] as const,
    effectiveMembers: (ownerId: string, mountId: string, pathId: string) =>
        [...driveKeys.effectiveMembersForOwner(ownerId), mountId, pathId] as const,
    trash: (ownerId: string) => [...driveKeys.owner(ownerId), 'trash'] as const,
    trashList: (ownerId: string, mountId: string) => [...driveKeys.trash(ownerId), mountId] as const,
    history: (ownerId: string) => [...driveKeys.owner(ownerId), 'history'] as const,
    fileHistory: (ownerId: string, mountId: string, pathId: string, limit: number) =>
        [...driveKeys.history(ownerId), mountId, pathId, limit] as const,
    watches: (ownerId: string) => [...driveKeys.owner(ownerId), 'watches'] as const,
    // Aggregate watches across the caller's own home, teams, and shared owners. Owner-less like
    // mimeAll: it always means "everything the current user watches".
    watchesAll: () => [...driveKeys.all, 'watchesAll'] as const,
    pathWatched: (ownerId: string, mountId: string, pathId: string) =>
        [...driveKeys.watches(ownerId), mountId, pathId] as const,
};

// SSE invalidation functions
export function invalidateAclSharedOrUnshared(queryClient: QueryClient, ownerId: string): void {
    queryClient.invalidateQueries({ queryKey: driveKeys.shared(ownerId, 'with-me') });
}

export function invalidateItemCreated(
    queryClient: QueryClient,
    ownerId: string,
    mountId: string,
    parentId: string | null | undefined,
    mimeType?: string | null,
): void {
    if (parentId) {
        queryClient.invalidateQueries({ queryKey: driveKeys.folder(ownerId, mountId, parentId) });
    }
    if (mimeType) {
        queryClient.invalidateQueries({ queryKey: driveKeys.mimeTypes(ownerId) });
        queryClient.invalidateQueries({ queryKey: driveKeys.mimeAllTypes() });
    }
    invalidateHomeSize(queryClient, ownerId);
}

export function invalidateItemDeleted(
    queryClient: QueryClient,
    ownerId: string,
    mountId: string,
    pathId: string,
    parentId: string | null | undefined,
    mimeType: string | null | undefined,
): void {
    if (parentId) {
        queryClient.invalidateQueries({ queryKey: driveKeys.folder(ownerId, mountId, parentId) });
    }
    queryClient.removeQueries({ queryKey: driveKeys.path(ownerId, mountId, pathId) });
    if (mimeType) {
        queryClient.invalidateQueries({ queryKey: driveKeys.mimeTypes(ownerId) });
        queryClient.invalidateQueries({ queryKey: driveKeys.mimeAllTypes() });
    }
    invalidateHomeSize(queryClient, ownerId);
}

export function invalidatePathRenamed(
    queryClient: QueryClient,
    ownerId: string,
    mountId: string,
    pathId: string,
    parentId: string | null | undefined,
    mimeType: string | null | undefined,
): void {
    queryClient.invalidateQueries({ queryKey: driveKeys.path(ownerId, mountId, pathId) });
    queryClient.invalidateQueries({ queryKey: collabKeys.document(ownerId, mountId, pathId) });
    if (parentId) {
        queryClient.invalidateQueries({ queryKey: driveKeys.folder(ownerId, mountId, parentId) });
    }
    if (mimeType) {
        queryClient.invalidateQueries({ queryKey: driveKeys.mimeTypes(ownerId) });
        queryClient.invalidateQueries({ queryKey: driveKeys.mimeAllTypes() });
    }
}

export function invalidatePathMoved(
    queryClient: QueryClient,
    ownerId: string,
    mountId: string,
    pathId: string,
    parentId: string | null | undefined,
    oldParentId: string | null | undefined,
): void {
    queryClient.invalidateQueries({ queryKey: driveKeys.path(ownerId, mountId, pathId) });
    if (parentId) {
        queryClient.invalidateQueries({ queryKey: driveKeys.folder(ownerId, mountId, parentId) });
    }
    if (oldParentId) {
        queryClient.invalidateQueries({ queryKey: driveKeys.folder(ownerId, mountId, oldParentId) });
    }
}

export function invalidateAclUpdated(
    queryClient: QueryClient,
    ownerId: string,
    mountId: string,
    pathId: string,
    parentId: string | null | undefined,
    mimeType: string | null | undefined,
): void {
    queryClient.invalidateQueries({ queryKey: driveKeys.shared(ownerId, 'by-me') });
    queryClient.invalidateQueries({ queryKey: driveKeys.shared(ownerId, 'with-me') });
    queryClient.invalidateQueries({ queryKey: driveKeys.path(ownerId, mountId, pathId) });
    queryClient.invalidateQueries({ queryKey: driveKeys.permissions(ownerId, mountId, pathId) });
    if (parentId) {
        queryClient.invalidateQueries({ queryKey: driveKeys.folder(ownerId, mountId, parentId) });
    }
    // The eigendoc app listings (stickies/docs/slides/sheets) render from the mime-type
    // queries and pass their row objects into the share dialog — without this, the dialog
    // reopens on a stale ACL after a change made from those views.
    if (mimeType) {
        queryClient.invalidateQueries({ queryKey: driveKeys.mimeTypes(ownerId) });
        queryClient.invalidateQueries({ queryKey: driveKeys.mimeAllTypes() });
    }
}

export function invalidateTrash(queryClient: QueryClient, ownerId: string, mountId: string): void {
    queryClient.invalidateQueries({ queryKey: driveKeys.trashList(ownerId, mountId) });
}

// Owner-broad prefix invalidation: an ancestor ACL change alters effective membership for every
// descendant, so per-path invalidation is insufficient — drop the whole effective-members family.
export function invalidateEffectiveMembers(queryClient: QueryClient, ownerId: string): void {
    queryClient.invalidateQueries({ queryKey: driveKeys.effectiveMembersForOwner(ownerId) });
}
