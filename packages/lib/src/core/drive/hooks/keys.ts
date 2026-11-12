// The Drive query keys, each scoped to an owner but for a few that mean everything the user sees, and the
// invalidators that write hooks and the drive SSE handler call after a change. A write hook names its change, such
// as a rename, and gets exactly the queries that change stales, each once for a whole batch. The SSE handler hears
// bursts, so it refreshes a path's own detail per event and every listing of the owner once per burst.

import type { QueryClient } from '@tanstack/react-query';
import type { DrivePath } from '@workspace/lib/types/drive';
import { DEFAULT_MOUNT_ID } from '@workspace/lib/types/mount';
import type { SSEventDrive } from '@workspace/lib/types/sse';
import { uniqBy } from 'es-toolkit';
import { invalidateCollabDocument, invalidateCollabMount } from '../../collab/hooks/keys';
import { invalidateHomeSize } from '../../home';

export { DEFAULT_MOUNT_ID };

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
    // The user's own and their teams' files of one type, so the key has no owner.
    mimeAllTypes: () => [...driveKeys.all, 'mimeAll'] as const,
    mimeAll: (mimeType: string) => [...driveKeys.mimeAllTypes(), mimeType] as const,
    mountMime: (ownerId: string, mountId: string, mimeType: string) =>
        [...driveKeys.mimeTypes(ownerId), mountId, mimeType] as const,
    path: (ownerId: string, mountId: string, pathId: string) =>
        [...driveKeys.owner(ownerId), 'path', mountId, pathId] as const,
    breadcrumbs: (ownerId: string) => [...driveKeys.owner(ownerId), 'breadcrumb'] as const,
    breadcrumb: (ownerId: string, mountId: string, pathId: string) =>
        [...driveKeys.breadcrumbs(ownerId), mountId, pathId] as const,
    permissions: (ownerId: string, mountId: string, pathId: string) =>
        [...driveKeys.owner(ownerId), 'permissions', mountId, pathId] as const,
    shared: (ownerId: string, to: 'by-me' | 'with-me') => [...driveKeys.owner(ownerId), 'shared', to] as const,
    textPreview: (ownerId: string, mountId: string, pathId: string, updatedAt?: Date) =>
        [...driveKeys.owner(ownerId), 'text-preview', mountId, pathId, updatedAt?.getTime()] as const,
    vcardPreview: (ownerId: string, mountId: string, pathId: string, updatedAt: Date) =>
        [...driveKeys.owner(ownerId), 'vcard-preview', mountId, pathId, updatedAt.getTime()] as const,
    emlPreview: (ownerId: string, mountId: string, pathId: string, updatedAt: Date) =>
        [...driveKeys.owner(ownerId), 'eml-preview', mountId, pathId, updatedAt.getTime()] as const,
    icsPreview: (ownerId: string, mountId: string, pathId: string, updatedAt: Date) =>
        [...driveKeys.owner(ownerId), 'ics-preview', mountId, pathId, updatedAt.getTime()] as const,
    effectiveMembersForOwner: (ownerId: string) => [...driveKeys.owner(ownerId), 'effective-members'] as const,
    effectiveMembers: (ownerId: string, mountId: string, pathId: string) =>
        [...driveKeys.effectiveMembersForOwner(ownerId), mountId, pathId] as const,
    trash: (ownerId: string) => [...driveKeys.owner(ownerId), 'trash'] as const,
    trashList: (ownerId: string, mountId: string) => [...driveKeys.trash(ownerId), mountId] as const,
    history: (ownerId: string) => [...driveKeys.owner(ownerId), 'history'] as const,
    fileHistory: (ownerId: string, mountId: string, pathId: string, limit: number) =>
        [...driveKeys.history(ownerId), mountId, pathId, limit] as const,
    watches: (ownerId: string) => [...driveKeys.owner(ownerId), 'watches'] as const,
    // Everything the user watches, in their own home, their teams' and their sharers', so the key has no owner.
    watchesAll: () => [...driveKeys.all, 'watchesAll'] as const,
    pathWatched: (ownerId: string, mountId: string, pathId: string) =>
        [...driveKeys.watches(ownerId), mountId, pathId] as const,
    recent: (ownerId: string) => [...driveKeys.owner(ownerId), 'recent'] as const,
};

// Where an item is listed: its folder, and the lists of its type when it has one.
type Listed = { ownerId: string; mountId: string; parentId?: string | null; mimeType?: string | null };

// The viewer's lists that hold what others shared with them: Shared with me and their own lists of one type.
export function invalidateAclSharedOrUnshared(queryClient: QueryClient, viewerId: string): void {
    queryClient.invalidateQueries({ queryKey: driveKeys.shared(viewerId, 'with-me') });
    queryClient.invalidateQueries({ queryKey: driveKeys.mimeTypes(viewerId) });
}

// The viewer's own lists of items from several owners, which show each item by name wherever it lives.
export function invalidateViewerLists(queryClient: QueryClient, viewerId: string): void {
    queryClient.invalidateQueries({ queryKey: driveKeys.shared(viewerId, 'by-me') });
    queryClient.invalidateQueries({ queryKey: driveKeys.shared(viewerId, 'with-me') });
    queryClient.invalidateQueries({ queryKey: driveKeys.recent(viewerId) });
    queryClient.invalidateQueries({ queryKey: driveKeys.watchesAll() });
}

// A path's own detail, such as its size, its etag or its members, after a change that keeps the path where it is.
export function invalidatePath(queryClient: QueryClient, ownerId: string, mountId: string, pathId: string): void {
    queryClient.invalidateQueries({ queryKey: driveKeys.path(ownerId, mountId, pathId) });
}

// A path that is gone is dropped, because a refetch of its detail or its breadcrumb would only fail.
export function forgetPath(queryClient: QueryClient, ownerId: string, mountId: string, pathId: string): void {
    queryClient.removeQueries({ queryKey: driveKeys.path(ownerId, mountId, pathId) });
    queryClient.removeQueries({ queryKey: driveKeys.breadcrumb(ownerId, mountId, pathId) });
}

// A breadcrumb holds the name and the ACL of every folder above its path, so a rename, a move or a new ACL of
// one folder stales the breadcrumbs of everything below it.
export function invalidateBreadcrumbs(queryClient: QueryClient, ownerId: string): void {
    queryClient.invalidateQueries({ queryKey: driveKeys.breadcrumbs(ownerId) });
}

export function invalidateItemCreated(
    queryClient: QueryClient,
    ownerId: string,
    mountId: string,
    parentId: string | null | undefined,
    mimeType?: string | null,
): void {
    invalidateListingsOf(queryClient, [{ ownerId, mountId, parentId, mimeType }]);
    invalidateHomeSize(queryClient, ownerId);
}

// Every folder and mime listing of the owner, for a caller that collapsed changes in several folders into one.
export function invalidateListings(queryClient: QueryClient, ownerId: string): void {
    queryClient.invalidateQueries({ queryKey: driveKeys.folders(ownerId) });
    queryClient.invalidateQueries({ queryKey: driveKeys.mimeTypes(ownerId) });
    queryClient.invalidateQueries({ queryKey: driveKeys.mimeAllTypes() });
    invalidateHomeSize(queryClient, ownerId);
}

export function invalidateItemsDeleted(queryClient: QueryClient, paths: readonly DrivePath[], viewerId: string): void {
    for (const path of paths) {
        forgetPath(queryClient, path.ownerId, path.mountId, path.id);
        invalidateHomeSize(queryClient, path.ownerId);
    }
    invalidateListingsOf(queryClient, paths);
    invalidateViewerLists(queryClient, viewerId);
}

export function invalidatePathRenamed(queryClient: QueryClient, path: DrivePath, viewerId: string): void {
    invalidatePath(queryClient, path.ownerId, path.mountId, path.id);
    invalidateCollabDocument(queryClient, path.ownerId, path.mountId, path.id);
    invalidateBreadcrumbs(queryClient, path.ownerId);
    invalidateListingsOf(queryClient, [path]);
    invalidateViewerLists(queryClient, viewerId);
}

// Takes the paths as they were before the move, so each parentId is the folder it left.
export function invalidatePathsMoved(
    queryClient: QueryClient,
    paths: readonly DrivePath[],
    targetParentId: string,
    viewerId: string,
): void {
    for (const path of paths) invalidatePath(queryClient, path.ownerId, path.mountId, path.id);
    for (const ownerId of new Set(paths.map((path) => path.ownerId))) invalidateBreadcrumbs(queryClient, ownerId);
    invalidateListingsOf(queryClient, [...paths, ...paths.map((path) => ({ ...path, parentId: targetParentId }))]);
    invalidateViewerLists(queryClient, viewerId);
}

export function invalidateAclUpdated(queryClient: QueryClient, path: SSEventDrive['path']): void {
    queryClient.invalidateQueries({ queryKey: driveKeys.shared(path.ownerId, 'by-me') });
    queryClient.invalidateQueries({ queryKey: driveKeys.shared(path.ownerId, 'with-me') });
    queryClient.invalidateQueries({ queryKey: driveKeys.permissions(path.ownerId, path.mountId, path.id) });
    invalidatePath(queryClient, path.ownerId, path.mountId, path.id);
    invalidateBreadcrumbs(queryClient, path.ownerId);
    invalidateCollabMount(queryClient, path.ownerId, path.mountId);
    // The document apps' lists read the mime queries and hand their rows to the share dialog, which would
    // otherwise reopen on the old ACL.
    invalidateListingsOf(queryClient, [path]);
}

export function invalidateTrash(queryClient: QueryClient, drives: readonly Listed[]): void {
    for (const { ownerId, mountId } of uniqBy(drives, (drive) => `${drive.ownerId}/${drive.mountId}`)) {
        queryClient.invalidateQueries({ queryKey: driveKeys.trashList(ownerId, mountId) });
    }
}

// An ancestor's ACL change alters the members of every path below it, so the owner's whole family goes.
export function invalidateEffectiveMembers(queryClient: QueryClient, ownerId: string): void {
    queryClient.invalidateQueries({ queryKey: driveKeys.effectiveMembersForOwner(ownerId) });
}

// The listings that show the items: each one's folder, and the lists of a type when one has a type. Each goes
// once however many of the items it shows, because every invalidation of an open listing starts its fetch.
function invalidateListingsOf(queryClient: QueryClient, items: readonly Listed[]): void {
    for (const { ownerId, mountId, parentId } of uniqBy(
        items,
        (item) => `${item.ownerId}/${item.mountId}/${item.parentId}`,
    )) {
        // A root has no folder.
        if (parentId) queryClient.invalidateQueries({ queryKey: driveKeys.folder(ownerId, mountId, parentId) });
    }
    const typed = items.filter((item) => item.mimeType);
    for (const ownerId of new Set(typed.map((item) => item.ownerId))) {
        queryClient.invalidateQueries({ queryKey: driveKeys.mimeTypes(ownerId) });
    }
    if (typed.length > 0) queryClient.invalidateQueries({ queryKey: driveKeys.mimeAllTypes() });
}
