import { parseOwnerId } from '@workspace/lib/types';
import type { ChatMatch } from '@workspace/lib/types/chat';
import { DRIVE_MIME_CHAT, type DriveACL, type DrivePath } from '@workspace/lib/types/drive';
import type { Drive } from '../drive';
import { getUserById, type User } from '../user/';

// Standalone chats whose current member set exactly equals {caller} ∪ picked emails — the
// new-chat wizard's open-don't-duplicate check. Candidates are the chats the caller can already
// see: their own mounts plus the shared-with-me mirror. Everything resolves in-process on the
// caller's Home (own mounts + local mirror db + local auth-db lookups) — no cross-home calls,
// per the SCALABILITY rule. See docs/PROPOSAL_CHAT_WIZARD.md § Duplicate detection semantics.
export async function findChatsByMembers(drive: Drive, user: User, emails: string[]): Promise<ChatMatch[]> {
    const target = new Set(emails.map((e) => e.toLowerCase()));
    target.add(user.email.toLowerCase());

    // getMimeTypeContents aggregates the caller's own mounts + the shared-with-me mirror. Own
    // paths carry the caller's ownerId; mirror rows carry the foreign owner's — that split drives
    // the two matching strategies below.
    const candidates = await drive.getMimeTypeContents(DRIVE_MIME_CHAT, { excludeDocumentChildren: true });

    // Repeat sharers show up across many candidate rows — resolve each owner id once per request.
    const ownerCache = new Map<string, User | null>();

    const matches: ChatMatch[] = [];
    const ownCandidates: DrivePath[] = [];
    for (const path of candidates) {
        // A public link or a direct team entry makes membership unbounded/dynamic, never a fixed
        // set of people — those chats are excluded from member matching. (A team entry inherited
        // from an ancestor folder is invisible here; the effective-members walk expands it to its
        // current members, so such a chat can still match its point-in-time membership — accepted,
        // like the mirror branch's inherited-ACL caveat. See CHAT.md § Matching semantics.)
        if (path.visibility !== 'private') continue;
        if (hasTeamEntry(path.acl)) continue;

        if (path.ownerId === user.id) {
            // Own chat: screen on the direct ACL before paying for the full effective-members walk
            // (a breadcrumb + per-team query — chat/chat.ts:154 flags the cost); survivors confirm
            // set equality in the concurrent pass below.
            if (directEmailsWithinTarget(path.acl, target)) ownCandidates.push(path);
        } else if (parseOwnerId(path.ownerId).type !== 'team') {
            // Shared-with-me chat: the mirror row carries only the direct ACL and the owner's id, so
            // the member set is {owner email} ∪ direct ACL emails (shared-with-me.ts). Team-owned
            // drives (team_* ownerId) imply all-team membership — never a fixed set — so skip them.
            if (!directEmailsWithinTarget(path.acl, target)) continue;
            // Size floor is sound ONLY here: mirror rows carry no inherited ancestor members, so
            // |effective| ≤ |direct ACL| + 1 (owner) — a larger target can never match. (The own
            // branch walks ancestors, so a smaller direct ACL can still match — no floor there.)
            // `<=` not `==`: an owner listed in their own ACL makes |effective| = |direct|.
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

    // Every unshared own chat passes the subset screen (empty ACL ⊆ target), so this walk runs for
    // most own candidates — run the independent walks concurrently instead of serializing on await.
    const ownMatches = await Promise.all(
        ownCandidates.map(async (path): Promise<ChatMatch | null> => {
            const members = await drive.getEffectiveMembers(path.mountId, path.id);
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

// Cheap necessary condition for the own-chat walk: every directly-shared email must be in the
// target set, since the effective set is a superset of the direct ACL — one stray direct member
// can never match. Inherited ancestor members are added by the walk, so a candidate with fewer
// direct members than the target can still match; we deliberately do NOT screen on ACL size.
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
