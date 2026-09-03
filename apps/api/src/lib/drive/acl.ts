import { parseOwnerId } from '@workspace/lib/types';
import {
    type DriveACL,
    type DriveACLDelta,
    type DrivePath,
    type DriveVisibility,
    isCollabType,
} from '@workspace/lib/types/drive';
import type { User } from '../user';
import type { Memberships } from '../user/';

export function grantsPublicRead(visibility: DriveVisibility): boolean {
    return visibility === 'public-read' || visibility === 'public-write';
}

// Ownership, team membership, public visibility or an ACL entry on the path or any ancestor.
function canFromAncestors(
    ancestors: DrivePath[],
    user: User,
    memberships: Memberships,
    permission: 'read' | 'write',
): boolean {
    for (const path of ancestors) {
        if (path.ownerId === user.id) return true;

        const parsed = parseOwnerId(path.ownerId);
        if (parsed.type === 'team') {
            if (memberships.teamIds.includes(parsed.id)) return true;
        }

        if (permission === 'read' ? grantsPublicRead(path.visibility) : path.visibility === 'public-write') {
            return true;
        }

        if (path.acl) {
            if (matchesACL(path.acl, user, memberships, permission)) return true;
        }
    }

    return false;
}

export function canReadFromAncestors(ancestors: DrivePath[], user: User, memberships: Memberships): boolean {
    return canFromAncestors(ancestors, user, memberships, 'read');
}

export function canWriteFromAncestors(ancestors: DrivePath[], user: User, memberships: Memberships): boolean {
    return canFromAncestors(ancestors, user, memberships, 'write');
}

export function matchesACL(
    acl: DriveACL[],
    user: User,
    memberships: Memberships,
    permission: 'read' | 'write',
): boolean {
    for (const entry of acl) {
        const hasPermission = permission === 'read' ? entry.read : entry.write;
        if (!hasPermission) continue;

        const parsed = parseOwnerId(entry.id);

        if (parsed.type === 'user' && entry.id.toLowerCase() === user.email.toLowerCase()) {
            return true;
        }

        if (parsed.type === 'team') {
            if (memberships.teamIds.includes(parsed.id)) return true;
        }
    }
    return false;
}

// Merges an add/remove delta onto the current ACL: removals first (case-insensitive id match),
// then upserts — re-adding an existing id replaces its entry, which is how permission changes
// travel. The server-side merge is what makes concurrent sharers safe: a full-array replace
// built from a stale client cache silently reverts other people's entries.
export function mergeACLDelta(current: DriveACL[] | null, delta: DriveACLDelta): DriveACL[] {
    const removed = new Set((delta.remove ?? []).map((id) => id.toLowerCase()));
    const merged = (current ?? []).filter((entry) => !removed.has(entry.id.toLowerCase()));
    for (const entry of delta.add ?? []) {
        const existing = merged.findIndex((e) => e.id.toLowerCase() === entry.id.toLowerCase());
        if (existing >= 0) {
            merged[existing] = entry;
        } else {
            merged.push(entry);
        }
    }
    return merged;
}

export function normalizeACL(acl: DriveACL[] | null): DriveACL[] | null {
    if (!acl || acl.length === 0) {
        return null;
    }

    return acl.map((a) => {
        const parsed = parseOwnerId(a.id);
        return {
            ...a,
            id: parsed.type === 'user' ? a.id.toLowerCase() : a.id,
        };
    });
}

// Walk the ancestors list (root-first) to find the outermost collab container.
// Returns null for standalone chats not inside a container.
export function findContainerFromAncestors(ancestors: DrivePath[]): DrivePath | null {
    let container: DrivePath | null = null;

    for (const path of ancestors) {
        if (isCollabType(path.type)) {
            container = path;
        }
    }

    return container;
}

// Splits an ACL into the entries worth storing and the ones an ancestor's ACL (or team
// ownership of the drive) already grants.
export function filterRedundantACL(
    acl: DriveACL[],
    path: DrivePath,
    ancestors: DrivePath[],
): { filtered: DriveACL[]; removed: DriveACL[] } {
    const inherited = new Map<string, { read: boolean; write: boolean }>();

    // Breadcrumbs include the path itself; without the skip every entry would cover itself.
    for (const ancestor of ancestors) {
        if (ancestor.id === path.id) continue;
        if (ancestor.acl) {
            for (const entry of ancestor.acl) {
                const key = entry.id.toLowerCase();
                if (!inherited.has(key)) {
                    inherited.set(key, { read: entry.read, write: entry.write });
                }
            }
        }
    }

    const ownerParsed = parseOwnerId(path.ownerId);

    const filtered: DriveACL[] = [];
    const removed: DriveACL[] = [];

    for (const entry of acl) {
        let isRedundant = false;
        const entryParsed = parseOwnerId(entry.id);

        // Team ACL on a path owned by the same team is always redundant
        if (ownerParsed.type === 'team' && entryParsed.type === 'team' && entryParsed.id === ownerParsed.id) {
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

    return { filtered, removed };
}
