import { parseOwnerId } from '@workspace/lib/types';
import type { ChatMatch } from '@workspace/lib/types/chat';
import { DRIVE_MIME_CHAT, type DriveACL, type DrivePath } from '@workspace/lib/types/drive';
import { ApiError } from '../core/errors';
import type { Drive } from '../drive';
import { getUserById, type User } from '../user/';

const MAX_MEMBER_WALKS = 200;

// Standalone chats whose member set exactly equals {caller} ∪ emails — the wizard's
// open-don't-duplicate lookup. Runs entirely on the caller's Home (no cross-home calls).
// Semantics + accepted caveats: docs/CHAT.md § Matching semantics.
export async function findChatsByMembers(drive: Drive, user: User, emails: string[]): Promise<ChatMatch[]> {
    const target = new Set(emails.map((e) => e.toLowerCase()));
    target.add(user.email.toLowerCase());

    // Own paths carry the caller's ownerId, mirror rows the foreign owner's — that split
    // drives the two matching strategies below.
    const candidates = await drive.getMimeTypeContents(DRIVE_MIME_CHAT);

    // Repeat sharers appear across many rows — resolve each owner once per request.
    const ownerCache = new Map<string, User | null>();

    const matches: ChatMatch[] = [];
    const ownCandidates: DrivePath[] = [];
    for (const path of candidates) {
        // Public links and direct team entries make membership dynamic, never a fixed set.
        // (Ancestor-inherited team entries still expand in the walk — accepted caveat.)
        if (path.visibility !== 'private') continue;
        if (hasTeamEntry(path.acl)) continue;

        if (path.ownerId === user.id) {
            // Cheap direct-ACL screen before the costly effective-members walk below.
            if (directEmailsWithinTarget(path.acl, target)) ownCandidates.push(path);
        } else if (parseOwnerId(path.ownerId).type !== 'team') {
            // Mirror rows carry only the direct ACL + owner id, so members = {owner} ∪ direct ACL.
            if (!directEmailsWithinTarget(path.acl, target)) continue;
            // No inherited members here, so |effective| ≤ |direct|+1 — a larger target can never
            // match. (`<=` not `==`: an owner listed in their own ACL makes them equal.)
            if (target.size > (path.acl?.length ?? 0) + 1) continue;
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

    // Every unshared own chat passes the subset screen, so run the walks concurrently — but
    // capped, newest first: each walk costs a breadcrumb + ACL resolve, and a huge chat history
    // must not fan out unbounded. A match past the cap is missed (the wizard offers create
    // instead of open) — accepted caveat, docs/CHAT.md § Matching semantics.
    ownCandidates.sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
    const ownMatches = await Promise.all(
        ownCandidates.slice(0, MAX_MEMBER_WALKS).map(async (path): Promise<ChatMatch | null> => {
            // A candidate trashed between the snapshot and its walk 404s — skip it, don't
            // fail the whole batch.
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

    // Writable first (a chat you can post in beats a read-only one), then most-recently-touched.
    matches.sort(
        (a, b) => Number(b.canWrite) - Number(a.canWrite) || b.path.updatedAt.getTime() - a.path.updatedAt.getTime(),
    );
    return matches;
}

function hasTeamEntry(acl: DriveACL[] | null): boolean {
    return acl?.some((e) => parseOwnerId(e.id).type === 'team') ?? false;
}

// Necessary condition only: the effective set is a superset of the direct ACL, so one stray
// direct member kills a match. Deliberately no size floor — an inherited-ACL chat carries an
// empty direct ACL yet must still match once the walk adds the ancestor members.
function directEmailsWithinTarget(acl: DriveACL[] | null, target: Set<string>): boolean {
    return (acl ?? []).every((e) => target.has(e.id.toLowerCase()));
}

function aclGrantsWrite(acl: DriveACL[] | null, email: string): boolean {
    const key = email.toLowerCase();
    return acl?.some((e) => e.id.toLowerCase() === key && e.write) ?? false;
}

function sameSet(emails: string[], target: Set<string>): boolean {
    const set = new Set(emails);
    if (set.size !== target.size) return false;
    for (const email of set) {
        if (!target.has(email)) return false;
    }
    return true;
}
