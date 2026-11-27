// Who may read or write a Drive path, signed in or by its link, decided from the chain of folders above it, and what
// else that chain says, such as whether the path is in the trash or inside a document. Every access check reads it,
// such as SharedDrive's before a call it passes on. The helpers that merge, normalize and trim an ACL before Drive
// saves it live here too.

import { CONTAINER_CHAT_FOLDER, CONTAINER_MEDIA_FOLDER } from '@workspace/lib/constants/container';
import type { DrivePath, DrivePathType } from '@workspace/lib/types/drive';
import {
    DRIVE_TYPE_CHAT,
    DRIVE_TYPE_FILE,
    DRIVE_TYPE_FOLDER,
    isCollabType,
    isDocumentMediaFolder,
    isDocumentType,
} from '@workspace/lib/types/drive';
import type { DriveACL, DriveACLDelta, DrivePathPermissions, DriveVisibility } from '@workspace/lib/types/drive-access';
import { holdsByName } from '@workspace/lib/types/drive-access';
import { parseOwnerId } from '@workspace/lib/types/owner';
import { validateEmailAddress } from '@workspace/lib/validation';
import { ApiError } from '../core';
import type { TransformPriority } from '../document/transform/runner';
import { isContainerDatabase } from '../mount/container-dbs';
import type { Memberships, User } from '../user';
import { isVersionsFolder } from '../versioning/versions-folder';

export type ReaderAccess = DrivePathPermissions & { live: boolean; priority: TransformPriority };

// While public links are off a link is private to everyone. Its value stays, so turning them on opens it again.
export function grantsPublicRead(visibility: DriveVisibility, publicLinks: boolean): boolean {
    if (visibility === 'link') return publicLinks;
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

// Whether the path is a raw database: a container's own, such as a document's data.db or a thread's, or a document's
// saved version. Each keeps what the merged state leaves out, such as deleted text. The chain ends with the path itself.
export function isRawDatabase(chain: readonly DrivePath[]): boolean {
    const [document, folder, path] = [chain.at(-3), chain.at(-2), chain.at(-1)];
    if (folder === undefined || path?.type !== DRIVE_TYPE_FILE) return false;
    const isVersion = document !== undefined && isCollabType(document.type) && isVersionsFolder(folder);
    return isVersion || isContainerDatabase(path.name, folder.type);
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

// What a visitor without a login may read: the index of the highest path with a link, or null. A visitor is never live,
// so a raw database is refused as for every such reader. Past that the chain is folders, then at most a file, or a
// collab document and at most its media/ and a file in it. The link is at or above that end.
export function canReadByLink(chain: readonly DrivePath[]): number | null {
    const head = chain.findIndex((path) => path.visibility === 'link');
    if (head < 0 || isTrashedChain(chain)) return null;
    const end = chain.findIndex((path) => path.type !== DRIVE_TYPE_FOLDER);
    if (end < 0) return head;
    if (head > end) return null;
    const [item, media, file, ...deeper] = chain.slice(end);
    const endsInFile = item?.type === DRIVE_TYPE_FILE && media === undefined;
    const endsInDocument = item !== undefined && isCollabType(item.type) && media === undefined;
    const endsInMedia =
        isDocumentMediaFolder(item, media) &&
        (file === undefined || file.type === DRIVE_TYPE_FILE) &&
        deeper.length === 0;
    return endsInFile || endsInDocument || endsInMedia ? head : null;
}

// Held by name, or outside the trash a signed-in link or, while public links are on, a public link. A raw database
// keeps deleted text, so through a visibility alone only someone who may also write it reads it, a live reader.
export function canReadFromAncestors(
    chain: readonly DrivePath[],
    user: User,
    memberships: Memberships,
    publicLinks: boolean,
): boolean {
    if (holdsByName(chain, user, memberships.teamIds, 'read')) return true;
    if (isTrashedChain(chain) || !chain.some((path) => grantsPublicRead(path.visibility, publicLinks))) return false;
    return !isRawDatabase(chain) || canWriteFromAncestors(chain, user, memberships);
}

export function canWriteFromAncestors(chain: readonly DrivePath[], user: User, memberships: Memberships): boolean {
    if (holdsByName(chain, user, memberships.teamIds, 'write')) return true;
    return !isTrashedChain(chain) && chain.some((path) => path.visibility === 'public-write');
}

// What a signed-in reader may do with a path. A live reader syncs it over the collab socket: they read it by name, or
// may both write and read it, as an ACL entry can grant write alone. Only a reader by name runs its transforms at
// foreground priority, so a burst of views through a public or signed-in link can't take the one transform queue from
// the people it is shared with.
export function readerAccess(
    chain: readonly DrivePath[],
    user: User,
    memberships: Memberships,
    publicLinks: boolean,
): ReaderAccess {
    const readsByName = holdsByName(chain, user, memberships.teamIds, 'read');
    const canRead = canReadFromAncestors(chain, user, memberships, publicLinks);
    const canWrite = canWriteFromAncestors(chain, user, memberships);
    return {
        canRead,
        canWrite,
        live: readsByName || (canWrite && canRead),
        priority: readsByName ? 'foreground' : 'background',
    };
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
