// Who may read or write a Drive path: the ACL entries a path carries and its public visibility, the delta a client
// sends to change them, and what the sharing routes answer, such as the share dialog's access list. The API checks
// access with these shapes and the share dialog shows them.

export type DriveACL = {
    id: string;
    read: boolean;
    write: boolean;
};

// What a client sends the ACL route: only what changed, which the server merges into the current ACL. The route takes
// no full list, because replacing the whole list would drop the entries another sharer added at the same time.
export type DriveACLDelta = {
    add?: DriveACL[];
    remove?: string[];
};

export type DriveVisibility = 'private' | 'public-read' | 'public-write';

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
