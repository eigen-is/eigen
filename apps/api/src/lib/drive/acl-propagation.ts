import { parseOwnerId, teamOwnerId } from '@workspace/lib/types';
import type { DriveACL, DrivePath } from '@workspace/lib/types/drive';
import { getServerSettings } from '../config/server-settings';
import { composeShareEmail } from '../core/mail-composers';
import { sendMail } from '../core/mailer';
import { sendToHome } from '../home/home-relay';
import { addRegistryEntry } from '../share';
import { getTeamMembers } from '../team';
import { getUserByEmail } from '../user/';

export async function resolveACLUserIds(ownerId: string, acls: DriveACL[]): Promise<Set<string>> {
    const ids = new Set<string>();
    for (const acl of acls) {
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

export type EffectiveMember = { email: string; read: boolean; write: boolean };

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
): Promise<void> {
    const settings = getServerSettings();
    for (const email of addedUserEmails) {
        const target = await getUserByEmail(email);
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

export async function propagateACLChange(
    path: DrivePath,
    oldACL: DriveACL[] | null,
    newACL: DriveACL[] | null,
    actor: { name: string; email: string } | null,
): Promise<void> {
    const ids = await resolveACLUserIds(path.ownerId, [...(oldACL || []), ...(newACL || [])]);

    for (const id of ids) {
        try {
            await sendToHome(id, { type: 'drive:acl-change', path, acl: newACL, actorEmail: actor?.email });
        } catch (error) {
            console.error('Failed to propagate ACL change:', error);
        }
    }

    if (actor && newACL) {
        const addedUserEmails = diffACLEmails(oldACL, newACL).added.filter((e) => parseOwnerId(e).type === 'user');
        if (addedUserEmails.length > 0) {
            await emailNewlyAddedAclEntries(path, addedUserEmails, actor);
        }
    }
}
