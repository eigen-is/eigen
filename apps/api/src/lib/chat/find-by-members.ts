// Finds the chats whose members are exactly the caller and a given set of addresses, so the new-chat wizard can
// open a chat that already exists instead of making a second one. The chat route calls it. A chat shared with the
// caller is judged from its own ACL and its owner's user record, without a walk of the folders above it.

import { parseOwnerId } from '@workspace/lib/types';
import type { ChatMatch } from '@workspace/lib/types/chat';
import type { DriveACL, DrivePath } from '@workspace/lib/types/drive';
import { DRIVE_MIME_CHAT } from '@workspace/lib/types/drive';
import { ApiError } from '../core/errors';
import type { Drive } from '../drive';
import type { User } from '../user';
import { getUserById } from '../user';

const MAX_MEMBER_WALKS = 200;

export async function findChatsByMembers(drive: Drive, user: User, emails: readonly string[]): Promise<ChatMatch[]> {
    const target = new Set(emails.map((e) => e.toLowerCase()));
    target.add(user.email.toLowerCase());

    // Own chats carry the caller's ownerId and shared ones their owner's, and each kind is matched its own way.
    const candidates = await drive.getMimeTypeContents(DRIVE_MIME_CHAT);

    // One owner often shared several chats, so each owner is looked up once per request.
    const ownerCache = new Map<string, User | null>();

    const matches: ChatMatch[] = [];
    const ownCandidates: DrivePath[] = [];
    for (const path of candidates) {
        // A public link or a team entry lets in whoever follows or joins, so such a chat has no fixed set of members.
        if (path.visibility !== 'private') continue;
        if (hasTeamEntry(path.acl)) continue;

        if (path.ownerId === user.id) {
            // The chat's own ACL is checked first, as the walk of its members below costs far more.
            if (directEmailsWithinTarget(path.acl, target)) ownCandidates.push(path);
        } else if (parseOwnerId(path.ownerId).type !== 'team') {
            // Another owner's folders are not read here, so the members are the owner and the chat's own ACL.
            if (!directEmailsWithinTarget(path.acl, target)) continue;
            let owner = ownerCache.get(path.ownerId);
            if (owner === undefined) {
                owner = await getUserById(path.ownerId);
                ownerCache.set(path.ownerId, owner);
            }
            if (!owner) continue;
            const memberEmails = (path.acl ?? []).map((e) => e.id.toLowerCase());
            memberEmails.push(owner.email.toLowerCase());
            if (sameSet(memberEmails, target)) {
                matches.push({ path, canWrite: aclGrantsWrite(path.acl, user.email) });
            }
        }
    }

    // Every unshared own chat passes the subset screen, so the walks are capped, newest first: each costs a
    // breadcrumb and an ACL resolve, and a large chat history must not fan out unbounded.
    ownCandidates.sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
    const ownMatches = await Promise.all(
        ownCandidates.slice(0, MAX_MEMBER_WALKS).map(async (path): Promise<ChatMatch | null> => {
            // A chat trashed since the list was read answers 404, which must not fail the other walks.
            const members = await drive.getEffectiveMembers(path.mountId, path.id).catch((err) => {
                if (err instanceof ApiError && err.status === 404) return null;
                throw err;
            });
            if (!members) return null;
            return sameSet(
                members.map((m) => m.email.toLowerCase()),
                target,
            )
                ? { path, canWrite: true }
                : null;
        }),
    );
    matches.push(...ownMatches.filter((m) => m !== null));

    // A chat the caller can post in comes before a read-only one, and then the newest first.
    matches.sort(
        (a, b) => Number(b.canWrite) - Number(a.canWrite) || b.path.updatedAt.getTime() - a.path.updatedAt.getTime(),
    );
    return matches;
}

function hasTeamEntry(acl: readonly DriveACL[] | null): boolean {
    return acl?.some((e) => parseOwnerId(e.id).type === 'team') ?? false;
}

// No size floor, because a chat that inherits its ACL has an empty direct one and must still match once the walk
// adds the ancestor members.
function directEmailsWithinTarget(acl: readonly DriveACL[] | null, target: ReadonlySet<string>): boolean {
    return (acl ?? []).every((e) => target.has(e.id.toLowerCase()));
}

function aclGrantsWrite(acl: readonly DriveACL[] | null, email: string): boolean {
    const key = email.toLowerCase();
    return acl?.some((e) => e.id.toLowerCase() === key && e.write) ?? false;
}

function sameSet(emails: readonly string[], target: ReadonlySet<string>): boolean {
    const set = new Set(emails);
    if (set.size !== target.size) return false;
    for (const email of set) {
        if (!target.has(email)) return false;
    }
    return true;
}
