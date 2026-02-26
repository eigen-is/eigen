import type {User} from 'better-auth/types';
import type {DriveACL, DrivePath} from '@workspace/lib/types/drive';
import {parseOwnerId} from '@workspace/lib/types';
import type {Memberships} from './membership';

export type PathGetter = (pathId: string) => Promise<DrivePath | null>;
export type MembershipGetter = (userId: string) => Promise<Memberships>;

export async function canRead(
    path: DrivePath,
    user: User,
    getPath: PathGetter,
    getMemberships?: MembershipGetter
): Promise<boolean> {
    if (path.ownerId === user.id) return true;

    // Team-owned paths: members get automatic read access
    if (getMemberships) {
        const parsed = parseOwnerId(path.ownerId);
        if (parsed.type === 'team') {
            const memberships = await getMemberships(user.id);
            if (memberships.teamIds.includes(parsed.id)) return true;
        }
    }

    if (path.visibility === 'public-read' || path.visibility === 'public-write') return true;

    // Check ACL entries (user, team)
    if (path.acl) {
        if (await matchesACL(path.acl, user, 'read', getMemberships)) return true;
    }

    if (path.parentId) {
        const parent = await getPath(path.parentId);
        if (parent) return canRead(parent, user, getPath, getMemberships);
    }

    return false;
}

export async function canWrite(
    path: DrivePath,
    user: User,
    getPath: PathGetter,
    getMemberships?: MembershipGetter
): Promise<boolean> {
    if (path.ownerId === user.id) return true;

    // Team-owned paths: members get automatic write access
    if (getMemberships) {
        const parsed = parseOwnerId(path.ownerId);
        if (parsed.type === 'team') {
            const memberships = await getMemberships(user.id);
            if (memberships.teamIds.includes(parsed.id)) return true;
        }
    }

    if (path.visibility === 'public-write') return true;

    // Check ACL entries (user, team)
    if (path.acl) {
        if (await matchesACL(path.acl, user, 'write', getMemberships)) return true;
    }

    if (path.parentId) {
        const parent = await getPath(path.parentId);
        if (parent) return canWrite(parent, user, getPath, getMemberships);
    }

    return false;
}

async function matchesACL(
    acl: DriveACL[],
    user: User,
    permission: 'read' | 'write',
    getMemberships?: MembershipGetter
): Promise<boolean> {
    for (const entry of acl) {
        const hasPermission = permission === 'read' ? entry.read : entry.write;
        if (!hasPermission) continue;

        // Direct user match by email
        if ((!entry.type || entry.type === 'user') && entry.email.toLowerCase() === user.email.toLowerCase()) {
            return true;
        }

        // Team ACL: check if user is a member of the team
        if (entry.type === 'team' && entry.targetId && getMemberships) {
            const memberships = await getMemberships(user.id);
            if (memberships.teamIds.includes(entry.targetId)) return true;
        }
    }
    return false;
}

export function normalizeACL(acl: DriveACL[] | null): DriveACL[] | null {
    if (!acl || acl.length === 0) {
        return null;
    }

    return acl.map(a => ({
        ...a,
        email: a.email.toLowerCase()
    }));
}

/**
 * Checks if an ACL entry is already covered by inherited permissions from parent paths
 * or by ownership of the drive (team membership).
 */
export async function filterRedundantACL(
    acl: DriveACL[],
    path: DrivePath,
    getPath: PathGetter,
): Promise<{filtered: DriveACL[], removed: DriveACL[]}> {
    // Collect inherited ACL from ancestors
    const inheritedUserEmails = new Map<string, {read: boolean, write: boolean}>();
    const inheritedTargets = new Map<string, {read: boolean, write: boolean}>();

    let current = path.parentId ? await getPath(path.parentId) : null;
    while (current) {
        if (current.acl) {
            for (const entry of current.acl) {
                if (entry.type === 'team') {
                    const key = `team:${entry.targetId}`;
                    if (!inheritedTargets.has(key)) {
                        inheritedTargets.set(key, {read: entry.read, write: entry.write});
                    }
                } else {
                    const email = entry.email.toLowerCase();
                    if (!inheritedUserEmails.has(email)) {
                        inheritedUserEmails.set(email, {read: entry.read, write: entry.write});
                    }
                }
            }
        }
        current = current.parentId ? await getPath(current.parentId) : null;
    }

    // Check ownership grants (team members automatically have full access)
    const parsed = parseOwnerId(path.ownerId);
    const ownerGrantsAll = parsed.type === 'team';

    const filtered: DriveACL[] = [];
    const removed: DriveACL[] = [];

    for (const entry of acl) {
        let isRedundant = false;

        if (entry.type === 'team') {
            const key = `team:${entry.targetId}`;

            // Team ACL on a path owned by the same team is always redundant
            if (ownerGrantsAll && entry.targetId === parsed.id) {
                isRedundant = true;
            }

            // Check if a parent already grants the same or broader permissions
            if (!isRedundant) {
                const inherited = inheritedTargets.get(key);
                if (inherited) {
                    const readCovered = !entry.read || inherited.read;
                    const writeCovered = !entry.write || inherited.write;
                    if (readCovered && writeCovered) isRedundant = true;
                }
            }
        } else {
            const email = entry.email.toLowerCase();

            // Check inherited user ACL
            const inherited = inheritedUserEmails.get(email);
            if (inherited) {
                const readCovered = !entry.read || inherited.read;
                const writeCovered = !entry.write || inherited.write;
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
