import { parseOwnerId, teamOwnerId } from '@workspace/lib/types';
import type { DriveACL, DrivePath, EffectiveMember } from '@workspace/lib/types/drive';
import { Semaphore } from '../../utils/semaphore';
import { getServerSettings } from '../config/server-settings';
import { composeShareEmail } from '../core/mail-composers';
import { sendMail } from '../core/mailer';
import { sendToHome } from '../home/home-relay';
import { addRegistryEntry } from '../share';
import { getTeamMembers } from '../team';
import { getUserByEmail } from '../user/';

// Opt-in (default share behaviour stays byte-identical): `true` skips the share email for entries
// that resolve to a registered user — mirror fan-out, SSE, and in-app notification still fire, and
// account-less emails keep the email as their only invite vehicle (used by the new-chat wizard).
// `'all'` additionally skips account-less emails — for internal grants that carry their own invite.
export type ACLPropagationOptions = { suppressShareEmail?: boolean | 'all' };

export async function resolveACLUserIds(ownerId: string, acls: DriveACL[]): Promise<Set<string>> {
    const ids = new Set<string>();
    // Dedupe by id up front — only acl.id drives resolution, and the restore path feeds [...acl, ...acl].
    const uniqueAcls = [...new Map(acls.map((acl) => [acl.id, acl])).values()];
    for (const acl of uniqueAcls) {
        const parsed = parseOwnerId(acl.id);
        if (parsed.type === 'user') {
            const user = await getUserByEmail(acl.id);
            if (user) {
                ids.add(user.id);
            } else {
                await addRegistryEntry(ownerId, acl.id);
            }
        } else if (parsed.type === 'team') {
            await addRegistryEntry(ownerId, teamOwnerId(parsed.id));
            const team = await getTeamMembers(parsed.id);
            for (const member of team) {
                ids.add(member.user.id);
            }
        }
    }
    return ids;
}

// Canonical ACL diff (lowercased entry ids, all entry types). History details and
// propagation both derive from this — one source of truth for "who was added/removed".
export function diffACLEmails(
    oldACL: DriveACL[] | null,
    newACL: DriveACL[] | null,
): { added: string[]; removed: string[] } {
    const oldEmails = new Set((oldACL ?? []).map((e) => e.id.toLowerCase()));
    const newEmails = new Set((newACL ?? []).map((e) => e.id.toLowerCase()));
    return {
        added: [...newEmails].filter((e) => !oldEmails.has(e)),
        removed: [...oldEmails].filter((e) => !newEmails.has(e)),
    };
}

// Resolves ACL entries to individual user emails with permissions.
// Teams are expanded to their members. Deduplicated by email (most permissive wins).
export async function resolveACLToEmails(acls: DriveACL[]): Promise<Map<string, EffectiveMember>> {
    const members = new Map<string, EffectiveMember>();

    function addMember(email: string, read: boolean, write: boolean) {
        const key = email.toLowerCase();
        const existing = members.get(key);
        if (existing) {
            existing.read = existing.read || read;
            existing.write = existing.write || write;
        } else {
            members.set(key, { email: key, read, write });
        }
    }

    for (const acl of acls) {
        const parsed = parseOwnerId(acl.id);
        if (parsed.type === 'team') {
            const teamMembers = await getTeamMembers(parsed.id);
            for (const m of teamMembers) {
                addMember(m.user.email, acl.read, acl.write);
            }
        } else {
            addMember(acl.id, acl.read, acl.write);
        }
    }
    return members;
}

async function emailNewlyAddedAclEntries(
    path: DrivePath,
    addedUserEmails: string[],
    actor: { name: string; email: string },
    suppress: boolean | 'all',
): Promise<void> {
    // 'all' suppresses every share email, including account-less invites the caller replaces itself.
    if (suppress === 'all') return;
    const settings = getServerSettings();
    for (const email of addedUserEmails) {
        const target = await getUserByEmail(email);
        // Suppression only covers users reachable in-app; an account-less email still needs the invite.
        if (suppress && target) continue;
        const isGuest = !target || target.role === 'guest';
        const enabled = isGuest
            ? settings.notifications.email.guestOnAclAdd
            : settings.notifications.email.userOnAclAdd;
        if (!enabled) continue;
        sendMail(composeShareEmail(path, email, actor)).catch((err) =>
            console.error('Failed to send share email:', err),
        );
    }
}

// Recipient delivery is asynchronous: shared_paths mirrors, notifications, and recipient SSE are
// derived state (enforcement is always owner-side via SharedDrive/canReadFromAncestors), so the
// request never waits for per-recipient home opens — a 25-person ACL previously cost 1–2s of
// sequential cold home opens. The semaphore bounds concurrent opens (each open Home costs
// ~25–30 fds); the per-path promise chain keeps rapid successive changes to the same path
// ordered per recipient — an out-of-order add→revoke would resurrect a stale mirror row. In-flight
// deliveries are lost on a crash (same window the old swallowed-error loop had); the durable
// outbox that closes it is roadmapped (ROADMAP.md § Durable home-relay outbox).
const FAN_OUT_CONCURRENCY = 8;
const fanOutSemaphore = new Semaphore(FAN_OUT_CONCURRENCY);
const pendingFanOuts = new Map<string, Promise<void>>();

function queueACLFanOut(
    ids: Set<string>,
    path: DrivePath,
    newACL: DriveACL[] | null,
    actorEmail?: string,
    actorName?: string,
): void {
    if (ids.size === 0) return;
    const prev = pendingFanOuts.get(path.id) ?? Promise.resolve();
    const next = prev.then(() =>
        Promise.all(
            [...ids].map((id) =>
                fanOutSemaphore.run(async () => {
                    try {
                        await sendToHome(id, { type: 'drive:acl-change', path, acl: newACL, actorEmail, actorName });
                    } catch (error) {
                        console.error(`Failed to propagate ACL change to ${id}:`, error);
                    }
                }),
            ),
        ).then(() => undefined),
    );
    pendingFanOuts.set(path.id, next);
    next.finally(() => {
        if (pendingFanOuts.get(path.id) === next) {
            pendingFanOuts.delete(path.id);
        }
    });
}

// Awaits every queued delivery (including ones queued while draining). Used by tests for
// read-your-fanout determinism and by graceful shutdown — must run BEFORE shutdownAllHomes,
// since delivery reopens recipient homes.
export async function drainACLFanOuts(): Promise<void> {
    while (pendingFanOuts.size > 0) {
        await Promise.allSettled([...pendingFanOuts.values()]);
    }
}

export async function propagateSharedPathChange(
    path: DrivePath,
    oldACL: DriveACL[] | null,
    newACL: DriveACL[] | null,
    actor: { name: string; email: string } | null,
    options?: ACLPropagationOptions,
): Promise<void> {
    // Target resolution stays on the awaited path: the registry writes inside are the durable
    // record for not-yet-registered targets and must survive the request.
    const ids = await resolveACLUserIds(path.ownerId, [...(oldACL || []), ...(newACL || [])]);

    queueACLFanOut(ids, path, newACL, actor?.email, actor?.name);

    if (actor && newACL) {
        const addedUserEmails = diffACLEmails(oldACL, newACL).added.filter((e) => parseOwnerId(e).type === 'user');
        if (addedUserEmails.length > 0) {
            await emailNewlyAddedAclEntries(path, addedUserEmails, actor, options?.suppressShareEmail ?? false);
        }
    }
}
