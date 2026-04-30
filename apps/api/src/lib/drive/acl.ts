import { parseOwnerId } from '@workspace/lib/types';
import { type DriveACL, type DrivePath, isCollabType } from '@workspace/lib/types/drive';
import type { Memberships } from '../user/';

// Minimal shape of the authenticated subject the ACL layer needs. better-auth's `User`
// and `ProtocolUser` (basic-auth result) are both structural supertypes of this, so
// callers can pass either without casting.
export type AuthSubject = { id: string; email: string };

export function canReadFromAncestors(ancestors: DrivePath[], user: AuthSubject, memberships: Memberships): boolean {
    for (const path of ancestors) {
        if (path.ownerId === user.id) return true;

        const parsed = parseOwnerId(path.ownerId);
        if (parsed && parsed.type === 'team') {
            if (memberships.teamIds.includes(parsed.id)) return true;
        }

        if (path.visibility === 'public-read' || path.visibility === 'public-write') return true;

        if (path.acl) {
            if (matchesACL(path.acl, user, memberships, 'read')) return true;
        }
    }

    return false;
}

export function canWriteFromAncestors(ancestors: DrivePath[], user: AuthSubject, memberships: Memberships): boolean {
    for (const path of ancestors) {
        if (path.ownerId === user.id) return true;

        const parsed = parseOwnerId(path.ownerId);
        if (parsed && parsed.type === 'team') {
            if (memberships.teamIds.includes(parsed.id)) return true;
        }

        if (path.visibility === 'public-write') return true;

        if (path.acl) {
            if (matchesACL(path.acl, user, memberships, 'write')) return true;
        }
    }

    return false;
}

export function matchesACL(
    acl: DriveACL[],
    user: AuthSubject,
    memberships: Memberships,
    permission: 'read' | 'write',
): boolean {
    for (const entry of acl) {
        const hasPermission = permission === 'read' ? entry.read : entry.write;
        if (!hasPermission) continue;

        const parsed = parseOwnerId(entry.id);

        if (parsed && parsed.type === 'user' && entry.id.toLowerCase() === user.email.toLowerCase()) {
            return true;
        }

        if (parsed && parsed.type === 'team') {
            if (memberships.teamIds.includes(parsed.id)) return true;
        }
    }
    return false;
}

export function normalizeACL(acl: DriveACL[] | null): DriveACL[] | null {
    if (!acl || acl.length === 0) {
        return null;
    }

    return acl.map((a) => {
        const parsed = parseOwnerId(a.id);
        return {
            ...a,
            id: parsed && parsed.type === 'user' ? a.id.toLowerCase() : a.id,
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

// Checks if an ACL entry is already covered by inherited permissions from ancestor
// paths or by ownership of the drive (team membership).
export function filterRedundantACL(
    acl: DriveACL[],
    path: DrivePath,
    ancestors: DrivePath[],
): { filtered: DriveACL[]; removed: DriveACL[] } {
    const inherited = new Map<string, { read: boolean; write: boolean }>();

    // ancestors excludes the path itself, so every entry is a parent/grandparent
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
        if (
            entryParsed &&
            ownerParsed &&
            ownerParsed.type === 'team' &&
            entryParsed.type === 'team' &&
            entryParsed.id === ownerParsed.id
        ) {
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
