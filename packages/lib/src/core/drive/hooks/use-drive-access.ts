// Who can reach a Drive item, as the share dialog and the detail panel show it: the owner and the item's own
// ACL entries first, then what each parent folder grants, each person once. The rest of the file answers
// smaller questions, such as whether the user owns an item directly or through a team, or had it shared.

import type { UseQueryResult } from '@tanstack/react-query';
import type { ParsedOwnerId, PublicUser } from '@workspace/lib/types';
import { parseOwnerId } from '@workspace/lib/types';
import type { DrivePath } from '@workspace/lib/types/drive';
import type { DirectAccessItem, DriveAccessItem, InheritedAccessItem } from '@workspace/lib/types/drive-access';
import { useCallback, useMemo } from 'react';
import { useAuth } from '../../auth';
import { useMyTeams } from '../../home';
import { usePublicUser } from '../../public';
import { useBreadcrumb } from './reads';

type DriveAccess = {
    parsedOwner: ParsedOwnerId;
    isGroupOwned: boolean;
    owner: UseQueryResult<PublicUser | null>;
    breadcrumb: UseQueryResult<DrivePath[]>;
    baseDirectList: DirectAccessItem[];
    directList: DirectAccessItem[];
    inheritedList: InheritedAccessItem[];
    allEntries: DriveAccessItem[];
};

export function useDriveAccess(
    path: DrivePath,
    overrideDirectList?: DirectAccessItem[],
    preloadedBreadcrumb?: DrivePath[],
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

// True when the path's own ACL names the current user by email — a direct share, which a delete
// leaves (SharedDrive.deletePath). Access through a shared folder, a team drive or a team ACL
// entry is not one: a delete there trashes the owner's copy.
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
