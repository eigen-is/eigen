import type {User} from 'better-auth/types';
import {type DriveACL, type DrivePath} from '@workspace/lib/types/drive';
import {parseOwnerId} from '@workspace/lib/types';
import {getMemberships} from '../user/';

export type PathGetter = (pathId: string) => Promise<DrivePath | null>;

export async function canRead(
    path: DrivePath,
    user: User,
    getPath: PathGetter,
): Promise<boolean> {
    if (path.ownerId === user.id) return true;

    // Team-owned paths: members get automatic read access
    const parsed = parseOwnerId(path.ownerId);
    if (parsed && parsed.type === 'team') {
        const memberships = await getMemberships(user.id);
        if (memberships.teamIds.includes(parsed.id)) return true;
    }

    if (path.visibility === 'public-read' || path.visibility === 'public-write') return true;

    // Check ACL entries (user, team)
    if (path.acl) {
        if (await matchesACL(path.acl, user, 'read')) return true;
    }

    if (path.parentId) {
        const parent = await getPath(path.parentId);
        if (parent) return canRead(parent, user, getPath);
    }

    return false;
}

export async function canWrite(
    path: DrivePath,
    user: User,
    getPath: PathGetter
): Promise<boolean> {
    if (path.ownerId === user.id) return true;

    // Team-owned paths: members get automatic write access
    const parsed = parseOwnerId(path.ownerId);
    if (parsed && parsed.type === 'team') {
        const memberships = await getMemberships(user.id);
        if (memberships.teamIds.includes(parsed.id)) return true;
    }

    if (path.visibility === 'public-write') return true;

    // Check ACL entries (user, team)
    if (path.acl) {
        if (await matchesACL(path.acl, user, 'write')) return true;
    }

    if (path.parentId) {
        const parent = await getPath(path.parentId);
        if (parent) return canWrite(parent, user, getPath);
    }

    return false;
}

export async function matchesACL(
    acl: DriveACL[],
    user: User,
    permission: 'read' | 'write'
): Promise<boolean> {
    for (const entry of acl) {
        const hasPermission = permission === 'read' ? entry.read : entry.write;
        if (!hasPermission) continue;

        const parsed = parseOwnerId(entry.id);

        if (parsed && parsed.type === 'user' && entry.id.toLowerCase() === user.email.toLowerCase()) {
            return true;
        }

        if (parsed && parsed.type === 'team') {
            const memberships = await getMemberships(user.id);
            if (memberships.teamIds.includes(parsed.id)) return true;
        }
    }
    return false;
}

export function normalizeACL(acl: DriveACL[] | null): DriveACL[] | null {
    if (!acl || acl.length === 0) {
        return null;
    }

    return acl.map(a => {
        const parsed = parseOwnerId(a.id);
        return {
            ...a,
            id: parsed && parsed.type === 'user' ? a.id.toLowerCase() : a.id,
        };
    });
}

/**
 * Checks if an ACL entry is already covered by inherited permissions from parent paths
 * or by ownership of the drive (team membership).
 */
export async function filterRedundantACL(
    acl: DriveACL[],
    path: DrivePath,
    getPath: PathGetter,
): Promise<{ filtered: DriveACL[], removed: DriveACL[] }> {
    const inherited = new Map<string, { read: boolean, write: boolean }>();

    let current = path.parentId ? await getPath(path.parentId) : null;
    while (current) {
        if (current.acl) {
            for (const entry of current.acl) {
                const key = entry.id.toLowerCase();
                if (!inherited.has(key)) {
                    inherited.set(key, {read: entry.read, write: entry.write});
                }
            }
        }
        current = current.parentId ? await getPath(current.parentId) : null;
    }

    const ownerParsed = parseOwnerId(path.ownerId);

    const filtered: DriveACL[] = [];
    const removed: DriveACL[] = [];

    for (const entry of acl) {
        let isRedundant = false;
        const entryParsed = parseOwnerId(entry.id);

        // Team ACL on a path owned by the same team is always redundant
        if (entryParsed && ownerParsed && ownerParsed.type === 'team' && entryParsed.type === 'team' && entryParsed.id === ownerParsed.id) {
            isRedundant = true;
        }

        if (!isRedundant) {
            const inheritedPerms = inherited.get(entry.id.toLowerCase());
            if (inheritedPerms) {
                const readCovered = !entry.read || inheritedPerms.read;
                const writeCovered = !entry.write || inheritedPerms.write;
                if (readCovered && writeCovered) isRedundant = true;
            }
        }

        if (isRedundant) {
            removed.push(entry);
        } else {
            filtered.push(entry);
        }
    }

    return {filtered, removed};
}
