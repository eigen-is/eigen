// Who may read or write a Drive path, decided from the chain of folders above it, and what else that chain says,
// such as whether the path is in the trash or inside a document. Every access check reads it, such as SharedDrive's
// before a call it passes on. The helpers that merge, normalize and trim an ACL before Drive saves it live here too.

import { CONTAINER_CHAT_FOLDER, CONTAINER_MEDIA_FOLDER } from '@workspace/lib/constants/container';
import type { DriveACL, DriveACLDelta, DrivePath, DrivePathType, DriveVisibility } from '@workspace/lib/types/drive';
import {
    DRIVE_TYPE_CHAT,
    DRIVE_TYPE_FILE,
    DRIVE_TYPE_FOLDER,
    isCollabType,
    isDocumentType,
} from '@workspace/lib/types/drive';
import { parseOwnerId } from '@workspace/lib/types/owner';
import { validateEmailAddress } from '@workspace/lib/validation';
import { ApiError } from '../core';
import type { Memberships, User } from '../user';

export function grantsPublicRead(visibility: DriveVisibility): boolean {
    return visibility === 'public-read' || visibility === 'public-write';
}

// Whether the path, or a folder above it, is in the trash. A path in the trash is the owner's alone until
// it is restored. Its ACL and visibility stay, so the restore gives everyone their access back.
export function isTrashedChain(ancestors: readonly DrivePath[]): boolean {
    return ancestors.some((path) => path.trashedAt);
}

// Whether a folder above the path is a document, so the path is one of its parts. The chain ends with the path itself.
export function isInsideDocument(chain: readonly DrivePath[]): boolean {
    return chain.slice(0, -1).some((crumb) => isDocumentType(crumb.type));
}

const DOCUMENT_WRITE_ERROR = 'Cannot change the inside of a document';

// The folders of a document a person may add to, and what each takes.
const OPEN_DOCUMENT_FOLDERS = new Map<string, DrivePathType>([
    [CONTAINER_MEDIA_FOLDER, DRIVE_TYPE_FILE],
    [CONTAINER_CHAT_FOLDER, DRIVE_TYPE_CHAT],
]);

// A person's write: adding a child of type `adding` to the last crumb, or with no `adding` changing the last crumb
// itself. Inside a document a person only adds a file to its media/ or a thread to its chat/.
export function refuseDocumentWrite(crumbs: readonly DrivePath[], adding?: DrivePathType): void {
    const inside = adding ? crumbs.some((crumb) => isDocumentType(crumb.type)) : isInsideDocument(crumbs);
    if (!inside) return;
    const document = crumbs.at(-2);
    const folder = crumbs.at(-1);
    const intoOpenFolder =
        adding !== undefined &&
        document !== undefined &&
        isDocumentType(document.type) &&
        folder?.type === DRIVE_TYPE_FOLDER &&
        OPEN_DOCUMENT_FOLDERS.get(folder.name) === adding;
    if (!intoOpenFolder) throw new ApiError(423, DOCUMENT_WRITE_ERROR);
}

// Ownership, team membership, public visibility or an ACL entry on the path or any ancestor. Only the
// first two count in the trash.
function canFromAncestors(
    ancestors: readonly DrivePath[],
    user: User,
    memberships: Memberships,
    permission: 'read' | 'write',
): boolean {
    const trashed = isTrashedChain(ancestors);
    for (const path of ancestors) {
        if (path.ownerId === user.id) return true;

        const parsed = parseOwnerId(path.ownerId);
        if (parsed.type === 'team' && memberships.teamIds.includes(parsed.id)) return true;

        if (trashed) continue;

        if (permission === 'read' ? grantsPublicRead(path.visibility) : path.visibility === 'public-write') {
            return true;
        }

        if (path.acl && matchesACL(path.acl, user, memberships, permission)) return true;
    }

    return false;
}

export function canReadFromAncestors(ancestors: readonly DrivePath[], user: User, memberships: Memberships): boolean {
    return canFromAncestors(ancestors, user, memberships, 'read');
}

export function canWriteFromAncestors(ancestors: readonly DrivePath[], user: User, memberships: Memberships): boolean {
    return canFromAncestors(ancestors, user, memberships, 'write');
}

export function matchesACL(
    acl: readonly DriveACL[],
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

        if (parsed.type === 'team' && memberships.teamIds.includes(parsed.id)) return true;
    }
    return false;
}

// The merge runs on the server, so two people who share at once keep each other's entries. An added entry
// for an id that is there already replaces it, which is how a permission changes.
export function mergeACLDelta(current: readonly DriveACL[] | null, delta: DriveACLDelta): DriveACL[] {
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

export function normalizeACL(acl: readonly DriveACL[] | null): DriveACL[] | null {
    if (!acl || acl.length === 0) {
        return null;
    }

    return acl.map((a) => ({ ...a, id: canonicalACLId(a.id) }));
}

// The innermost collab container in a root-first chain, or null for a chat on its own.
export function findContainerFromAncestors(ancestors: readonly DrivePath[]): DrivePath | null {
    return ancestors.findLast((path) => isCollabType(path.type)) ?? null;
}

// The entries of an ACL worth storing: those neither an ancestor's ACL nor the team that owns the drive grants.
export function filterRedundantACL(
    acl: readonly DriveACL[],
    path: DrivePath,
    ancestors: readonly DrivePath[],
): DriveACL[] {
    const inherited = new Map<string, { read: boolean; write: boolean }>();

    // Breadcrumbs include the path itself; without the skip every entry would cover itself.
    for (const ancestor of ancestors) {
        if (ancestor.id === path.id) continue;
        for (const entry of ancestor.acl ?? []) {
            const key = canonicalACLId(entry.id);
            if (!inherited.has(key)) inherited.set(key, { read: entry.read, write: entry.write });
        }
    }

    const ownerParsed = parseOwnerId(path.ownerId);
    return acl.filter((entry) => {
        const entryParsed = parseOwnerId(entry.id);
        const ownTeam = ownerParsed.type === 'team' && entryParsed.type === 'team' && entryParsed.id === ownerParsed.id;
        const granted = inherited.get(canonicalACLId(entry.id));
        const covered = granted !== undefined && (!entry.read || granted.read) && (!entry.write || granted.write);
        return !ownTeam && !covered;
    });
}
