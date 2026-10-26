// Who may read or write a Drive path, decided from the chain of folders above it. SharedDrive asks
// this before every call it passes on, and the watcher fan-out asks it before each notification. The
// helpers that merge, normalize and trim an ACL before Drive saves it live here too.

import { parseOwnerId } from '@workspace/lib/types';
import type { DriveACL, DriveACLDelta, DrivePath, DriveVisibility } from '@workspace/lib/types/drive';
import { isCollabType } from '@workspace/lib/types/drive';
import { validateEmailAddress } from '@workspace/lib/validation';
import type { User } from '../user';
import type { Memberships } from '../user/';

export function grantsPublicRead(visibility: DriveVisibility): boolean {
    return visibility === 'public-read' || visibility === 'public-write';
}

// Whether the path, or a folder above it, is in the trash. A path in the trash is the owner's alone until
// it is restored. Its ACL and visibility stay, so the restore gives everyone their access back.
export function isTrashedChain(ancestors: DrivePath[]): boolean {
    return ancestors.some((path) => path.trashedAt);
}

// Ownership, team membership, public visibility or an ACL entry on the path or any ancestor. Only the
// first two count in the trash.
function canFromAncestors(
    ancestors: DrivePath[],
    user: User,
    memberships: Memberships,
    permission: 'read' | 'write',
): boolean {
    const trashed = isTrashedChain(ancestors);
    for (const path of ancestors) {
        if (path.ownerId === user.id) return true;

        const parsed = parseOwnerId(path.ownerId);
        if (parsed.type === 'team') {
            if (memberships.teamIds.includes(parsed.id)) return true;
        }

        if (trashed) continue;

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

// Merges a change onto the ACL as it is now. The removals go first, matched by canonicalACLId. Then each
// added entry goes in, and one for an id that is there already replaces it, which is how a permission
// changes. The merge runs on the server, so two people who share at once keep each other's entries. A
// whole ACL built from an old copy in a tab would drop them.
export function mergeACLDelta(current: DriveACL[] | null, delta: DriveACLDelta): DriveACL[] {
    const removed = new Set((delta.remove ?? []).map(canonicalACLId));
    const merged = (current ?? []).filter((entry) => !removed.has(canonicalACLId(entry.id)));
    for (const entry of delta.add ?? []) {
        const existing = merged.findIndex((e) => canonicalACLId(e.id) === canonicalACLId(entry.id));
        if (existing >= 0) {
            merged[existing] = entry;
        } else {
            merged.push(entry);
        }
    }
    return merged;
}

// The comparison form of an ACL entry id. Only emails are case-insensitive; every other entry
// form (team, org, bare auth user id) is case-sensitive and lowercasing it resolves to nothing.
export function canonicalACLId(id: string): string {
    return validateEmailAddress(id) ? id.toLowerCase() : id;
}

export function normalizeACL(acl: DriveACL[] | null): DriveACL[] | null {
    if (!acl || acl.length === 0) {
        return null;
    }

    return acl.map((a) => ({ ...a, id: canonicalACLId(a.id) }));
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
                const key = canonicalACLId(entry.id);
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
            const inheritedPerms = inherited.get(canonicalACLId(entry.id));
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
