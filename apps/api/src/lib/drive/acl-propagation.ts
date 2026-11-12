// Tells the homes of the people a path is shared with that its sharing changed. It resolves who the
// ACL names, hands the push to the relay, and sends the share emails. Drive calls it after an ACL
// change.

import type { DriveACL, DrivePath, EffectiveMember } from '@workspace/lib/types/drive';
import { parseOwnerId, teamOwnerId } from '@workspace/lib/types/owner';
import { getServerSettings } from '../config/server-settings';
import { sendToUserHomes } from '../home/home-relay';
import { composeShareEmail } from '../mailer/mail-composers';
import { sendMail } from '../mailer/mailer';
import { addRegistryEntry } from '../share';
import { getTeamMembers } from '../team';
import { getUserByEmail, isGuest } from '../user';
import { canonicalACLId } from './acl';

// 'registered' skips the share email for a registered user, who still hears in the app, and an address
// without an account keeps the mail as its only invite. 'all' also skips those, for an internal grant
// that carries its own invite.
export type ACLPropagationOptions = { suppressShareEmail?: 'registered' | 'all' };

export async function resolveACLUserIds(ownerId: string, acls: DriveACL[]): Promise<Set<string>> {
    const ids = new Set<string>();
    // Only acl.id drives resolution, and the old and the new list mostly name the same people.
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
            for (const member of await getTeamMembers(parsed.id)) {
                ids.add(member.user.id);
            }
        }
    }
    return ids;
}

// Ids go through canonicalACLId, the rule normalizeACL stores them under: lowercasing them all would
// emit a team id that resolves to nothing.
export function diffACLPrincipals(
    oldACL: DriveACL[] | null,
    newACL: DriveACL[] | null,
): { added: string[]; removed: string[] } {
    const oldIds = new Set((oldACL ?? []).map((entry) => canonicalACLId(entry.id)));
    const newIds = new Set((newACL ?? []).map((entry) => canonicalACLId(entry.id)));
    return {
        added: [...newIds].filter((id) => !oldIds.has(id)),
        removed: [...oldIds].filter((id) => !newIds.has(id)),
    };
}

// The map is keyed by lowercased email, and the most permissive entry wins.
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

export async function resolveACLToEmails(acls: DriveACL[]): Promise<Map<string, EffectiveMember>> {
    const members = new Map<string, EffectiveMember>();

    for (const acl of acls) {
        const parsed = parseOwnerId(acl.id);
        if (parsed.type === 'team') {
            for (const member of await getTeamMembers(parsed.id)) {
                addEffectiveMember(members, member.user.email, acl.read, acl.write);
            }
        } else {
            addEffectiveMember(members, acl.id, acl.read, acl.write);
        }
    }
    return members;
}

export async function propagateSharedPathChange(
    path: DrivePath,
    oldACL: DriveACL[] | null,
    newACL: DriveACL[] | null,
    actor: { name: string; email: string } | null,
    options?: ACLPropagationOptions,
): Promise<void> {
    // Awaited, because its registry writes are the durable record for targets without an account.
    const ids = await resolveACLUserIds(path.ownerId, [...(oldACL ?? []), ...(newACL ?? [])]);

    // Delivery is derived state, since the owner's side enforces access, so the request doesn't wait for it.
    sendToUserHomes(ids, {
        type: 'drive:acl-change',
        path,
        acl: newACL,
        actorEmail: actor?.email,
        actorName: actor?.name,
    });

    const suppress = options?.suppressShareEmail;
    if (!actor || !newACL || suppress === 'all') return;
    const settings = getServerSettings();
    for (const email of diffACLPrincipals(oldACL, newACL).added) {
        if (parseOwnerId(email).type !== 'user') continue;
        const target = await getUserByEmail(email);
        // Suppression only covers users reachable in the app; an address without an account still needs the invite.
        if (suppress === 'registered' && target) continue;
        const toGuest = !target || isGuest(target);
        const enabled = toGuest
            ? settings.notifications.email.guestOnAclAdd
            : settings.notifications.email.userOnAclAdd;
        if (!enabled) continue;
        sendMail(composeShareEmail(path, email, actor)).catch((err) =>
            console.error('Failed to send share email:', err),
        );
    }
}
