// Who can reach a Drive item, as the share dialog and the detail panel show it: the owner and the item's own
// ACL entries first, then what each parent folder grants, each person once. The rest of the file answers
// smaller questions, such as whether the user owns an item directly or through a team, had it shared, holds write
// on it by name, or may write in a folder.

import type { UseQueryResult } from '@tanstack/react-query';
import type { DrivePath } from '@workspace/lib/types/drive';
import type {
    DirectAccessItem,
    DriveACL,
    DriveAccessItem,
    InheritedAccessItem,
} from '@workspace/lib/types/drive-access';
import type { ParsedOwnerId } from '@workspace/lib/types/owner';
import { parseOwnerId } from '@workspace/lib/types/owner';
import type { PublicUser } from '@workspace/lib/types/public';
import { useCallback, useMemo } from 'react';
import { useAuth, useIsGuest } from '../../auth';
import { useMyTeams } from '../../home';
import { usePublicUser } from '../../public';
import { useBreadcrumb } from './reads';
import { useCheckPermissions } from './sharing';

type DriveAccess = {
    parsedOwner: ParsedOwnerId;
    isGroupOwned: boolean;
    owner: UseQueryResult<PublicUser | null>;
    breadcrumb: UseQueryResult<DrivePath[]>;
    baseDirectList: readonly DirectAccessItem[];
    directList: readonly DirectAccessItem[];
    inheritedList: readonly InheritedAccessItem[];
    allEntries: readonly DriveAccessItem[];
};

export function useDriveAccess(
    path: DrivePath,
    overrideDirectList?: readonly DirectAccessItem[],
    preloadedBreadcrumb?: readonly DrivePath[],
): DriveAccess {
    const parsedOwner = useMemo(() => parseOwnerId(path.ownerId), [path.ownerId]);
    const isGroupOwned = parsedOwner.type === 'team';
    const owner = usePublicUser(path.ownerId);
    const breadcrumb = useBreadcrumb(path.ownerId, path.mountId, preloadedBreadcrumb ? undefined : path.id);

    const baseDirectList = useMemo<DirectAccessItem[]>(() => {
        const list: DirectAccessItem[] = [];

        if (isGroupOwned) {
            list.push({
                id: path.ownerId,
                read: true,
                write: true,
                owner: true,
            });
        } else if (owner.data?.email) {
            list.push({
                id: owner.data.email,
                read: true,
                write: true,
                owner: true,
            });
        } else {
            return [];
        }

        for (const access of path.acl ?? []) {
            if (!isGroupOwned && owner.data?.email && access.id.toLowerCase() === owner.data.email.toLowerCase()) {
                continue;
            }
            if (isGroupOwned && access.id.toLowerCase() === path.ownerId.toLowerCase()) {
                continue;
            }
            list.push({ id: access.id, read: access.read, write: access.write, owner: false });
        }

        return list;
    }, [path.acl, path.ownerId, isGroupOwned, owner.data?.email]);

    const directList = overrideDirectList ?? baseDirectList;

    const breadcrumbData = preloadedBreadcrumb ?? breadcrumb.data;
    const inheritedList = useMemo<InheritedAccessItem[]>(() => {
        if (!breadcrumbData || breadcrumbData.length === 0) return [];
        const directIds = new Set(directList.map((u) => u.id.toLowerCase()));
        if (owner.data?.email) directIds.add(owner.data.email.toLowerCase());
        if (isGroupOwned) directIds.add(path.ownerId.toLowerCase());

        const inherited: InheritedAccessItem[] = [];
        const seenKeys = new Set<string>();

        const ancestors = preloadedBreadcrumb ? breadcrumbData : breadcrumbData.slice(0, -1);
        for (const ancestor of [...ancestors].reverse()) {
            if (!ancestor.acl) continue;
            for (const acl of ancestor.acl) {
                const key = acl.id.toLowerCase();
                if (directIds.has(key) || seenKeys.has(key)) continue;
                seenKeys.add(key);
                inherited.push({
                    id: acl.id,
                    read: acl.read,
                    write: acl.write,
                    sourceFolderName: ancestor.name,
                });
            }
        }
        return inherited;
    }, [breadcrumbData, directList, owner.data?.email, isGroupOwned, path.ownerId, preloadedBreadcrumb]);

    const allEntries = useMemo<DriveAccessItem[]>(() => {
        const seen = new Set<string>();
        const result: DriveAccessItem[] = [];

        for (const item of directList) {
            const key = item.id.toLowerCase();
            if (!seen.has(key)) {
                seen.add(key);
                result.push(item);
            }
        }

        for (const item of inheritedList) {
            const key = item.id.toLowerCase();
            if (!seen.has(key)) {
                seen.add(key);
                result.push({ ...item, inherited: true });
            }
        }

        return result;
    }, [directList, inheritedList]);

    return {
        parsedOwner,
        isGroupOwned,
        owner,
        breadcrumb,
        baseDirectList,
        directList,
        inheritedList,
        allEntries,
    };
}

export function useIsEffectiveOwnerOf(): (ownerId: string) => boolean {
    const { user } = useAuth();
    const { data: myTeams } = useMyTeams();

    return useCallback(
        (ownerId: string) => {
            if (!user) return false;
            if (ownerId === user.id) return true;
            const parsed = parseOwnerId(ownerId);
            return parsed.type === 'team' && !!myTeams?.some((t) => t.id === parsed.id);
        },
        [user, myTeams],
    );
}

export function useIsEffectiveOwner(ownerId: string): boolean {
    return useIsEffectiveOwnerOf()(ownerId);
}

// An owner writes without asking the server; anyone else as the folder's share allows. The "root" alias names no
// folder to ask about until it resolves.
export function useCanWriteFolder(ownerId: string, mountId: string, pathId: string): boolean {
    const isOwner = useIsEffectiveOwner(ownerId);
    const askServer = !isOwner && pathId !== 'root';
    const { data: permissions } = useCheckPermissions(ownerId, mountId, askServer ? pathId : undefined);
    return isOwner || permissions?.canWrite === true;
}

// Whether the user holds write by name on an item in or at a folder, as the server decides it: an owner, or someone an
// entry on the item or a folder above it lets write, by email or team. Write from "Anyone signed in can edit" changes
// the content only, so it neither moves the item nor shares it. In the trash only an owner holds it. Until the folder's
// chain loads, only the item's own entries count.
export function useWritesByName(ownerId: string, mountId: string, folderId: string): (item: DrivePath) => boolean {
    const { user } = useAuth();
    const { data: myTeams } = useMyTeams();
    const isEffectiveOwnerOf = useIsEffectiveOwnerOf();
    const { data: chain } = useBreadcrumb(ownerId, mountId, folderId);
    return useCallback(
        (item: DrivePath) => {
            if (!user) return false;
            if (isEffectiveOwnerOf(item.ownerId)) return true;
            const crumbs = [...(chain ?? []), item];
            if (crumbs.some((crumb) => crumb.trashedAt)) return false;
            const email = user.email.toLowerCase();
            const holdsWrite = (entry: DriveACL) => {
                const parsed = parseOwnerId(entry.id);
                if (parsed.type === 'team') return !!myTeams?.some((team) => team.id === parsed.id);
                return entry.id.toLowerCase() === email;
            };
            return crumbs.some((crumb) => !!crumb.acl?.some((entry) => entry.write && holdsWrite(entry)));
        },
        [user, myTeams, isEffectiveOwnerOf, chain],
    );
}

// Whether the user may change who has access: write held by name, unless the owner restricted sharing. Nobody changes
// it on an item in the trash, whose access stays as it was for the restore.
export function useCanShare(path: DrivePath): boolean {
    const isGuest = useIsGuest();
    const isOwner = useIsEffectiveOwner(path.ownerId);
    const writesByName = useWritesByName(path.ownerId, path.mountId, path.id)(path);
    if (isGuest || path.trashedAt || !writesByName) return false;
    return isOwner || !path.sharingRestricted;
}

// Only the path's own ACL naming the user is a direct share, which a delete leaves instead of trashing the owner's
// copy. Access through a shared folder, a team drive or a team entry is not one.
export function useIsSharedWithMe(): (path: DrivePath) => boolean {
    const { user } = useAuth();
    const isEffectiveOwnerOf = useIsEffectiveOwnerOf();
    return useCallback(
        (path: DrivePath) =>
            !!user &&
            !isEffectiveOwnerOf(path.ownerId) &&
            !!path.acl?.some((entry) => entry.id.toLowerCase() === user.email.toLowerCase()),
        [user, isEffectiveOwnerOf],
    );
}
