// Who may read or write a Drive path: the ACL entries a path carries and its public visibility, the delta a client
// sends to change them, and what the sharing routes answer, such as the share dialog's access list. The rule for
// access held by name lives here too, so the API's checks and the browser's Move and Share answer it alike.

import type { DrivePath } from './drive';
import { parseOwnerId } from './owner';

export type DriveACL = {
    id: string;
    read: boolean;
    write: boolean;
};

type Person = { id: string; email: string };

// Access held by name: the person or a team they are in owns the path, or an ACL entry on the path or a folder above
// it names them. A path in the trash is its owners' alone until it is restored. The chain ends with the path itself.
export function holdsByName(
    chain: readonly DrivePath[],
    person: Person,
    teamIds: readonly string[],
    permission: 'read' | 'write',
): boolean {
    const owns = chain.some((path) => {
        const owner = parseOwnerId(path.ownerId);
        return path.ownerId === person.id || (owner.type === 'team' && teamIds.includes(owner.id));
    });
    if (owns) return true;
    if (chain.some((path) => path.trashedAt)) return false;
    return chain.some((path) => aclGrants(path.acl, person, teamIds, permission));
}

// Whether an entry gives the person the permission, by their email in any case or through a team they are in.
export function aclGrants(
    acl: readonly DriveACL[] | null,
    person: Person,
    teamIds: readonly string[],
    permission: 'read' | 'write',
): boolean {
    return (acl ?? []).some((entry) => {
        if (!entry[permission]) return false;
        const parsed = parseOwnerId(entry.id);
        if (parsed.type === 'team') return teamIds.includes(parsed.id);
        return parsed.type === 'user' && entry.id.toLowerCase() === person.email.toLowerCase();
    });
}

// What a client sends the ACL route: only what changed, which the server merges into the current ACL. The route takes
// no full list, because replacing the whole list would drop the entries another sharer added at the same time.
export type DriveACLDelta = {
    add?: DriveACL[];
    remove?: string[];
};

// 'link' opens the path to anyone with its URL, signed in or not; a signed-in user reads it as 'public-read'.
export type DriveVisibility = 'private' | 'public-read' | 'public-write' | 'link';

export type InviteResult = {
    alreadyHasAccess: boolean;
    targetPathId: string;
};

export type EffectiveMember = { email: string; read: boolean; write: boolean };

// What the caller may do with one path.
export type DrivePathPermissions = { canRead: boolean; canWrite: boolean };

// One row of the share dialog's access list. A direct entry is the path's own ACL plus the owner
// row the dialog synthesizes; an inherited one comes from an ancestor folder and names it.
export type DirectAccessItem = DriveACL & { owner: boolean };
export type InheritedAccessItem = DriveACL & { sourceFolderName: string };
export type DriveAccessItem =
    | (DirectAccessItem & { inherited?: never; sourceFolderName?: never })
    | (InheritedAccessItem & { owner?: never; inherited: true });

export type DriveAccessRecipient = { email: string; hasReadAccess: boolean; needsGuestAdmission: boolean };
export type DriveAccessCheckResult = { canShare: boolean; recipients: DriveAccessRecipient[] };
