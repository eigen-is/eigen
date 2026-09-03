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

// 'registered' skips the share email for entries that resolve to a registered user — mirror fan-out,
// SSE and the in-app notification still fire, and an account-less email keeps the mail as its only
// invite vehicle. 'all' also skips account-less emails, for internal grants carrying their own invite.
export type ACLPropagationOptions = { suppressShareEmail?: 'registered' | 'all' };

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

// Merge into an effective-member map keyed by lowercased email: most permissive wins.
export function addEffectiveMember(
    members: Map<string, EffectiveMember>,
    email: string,
    read: boolean,
    write: boolean,
): void {
    const key = email.toLowerCase();
    const existing = members.get(key);
    if (existing) {
        existing.read = existing.read || read;
        existing.write = existing.write || write;
    } else {
        members.set(key, { email: key, read, write });
    }
}

// Resolves ACL entries to individual user emails with permissions.
// Teams are expanded to their members. Deduplicated by email (most permissive wins).
export async function resolveACLToEmails(acls: DriveACL[]): Promise<Map<string, EffectiveMember>> {
    const members = new Map<string, EffectiveMember>();

    for (const acl of acls) {
        const parsed = parseOwnerId(acl.id);
        if (parsed.type === 'team') {
            const teamMembers = await getTeamMembers(parsed.id);
            for (const m of teamMembers) {
                addEffectiveMember(members, m.user.email, acl.read, acl.write);
            }
        } else {
            addEffectiveMember(members, acl.id, acl.read, acl.write);
        }
    }
    return members;
}

// Delivery is derived state (enforcement is always owner-side via SharedDrive/canReadFromAncestors),
// so the request never waits on per-recipient home opens. The semaphore bounds concurrent opens
// (~25–30 fds each); the per-path chain keeps successive changes to one path ordered per recipient,
// since an out-of-order add→revoke would resurrect a stale mirror row. In-flight deliveries are lost
// on a crash — the durable outbox that closes it is roadmapped (ROADMAP.md § Durable home-relay outbox).
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

    const suppress = options?.suppressShareEmail;
    if (actor && newACL && suppress !== 'all') {
        const addedUserEmails = diffACLEmails(oldACL, newACL).added.filter((e) => parseOwnerId(e).type === 'user');
        if (addedUserEmails.length > 0) {
            const settings = getServerSettings();
            for (const email of addedUserEmails) {
                const target = await getUserByEmail(email);
                // Suppression only covers users reachable in-app; an account-less email still needs the invite.
                if (suppress === 'registered' && target) continue;
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
    }
}
