// Who a path of a drive reaches, and the sharing actions built on that, such as mailing everyone with access or
// giving someone a chat. The members of a path come from the ACLs of its breadcrumb, and on a team drive from the
// team too. Drive methods such as getEffectiveMembers and inviteToChat call these, and the routes reach those
// through SharedDrive.

import type { DrivePath } from '@workspace/lib/types/drive';
import type {
    DriveAccessCheckResult,
    DriveAccessRecipient,
    EffectiveMember,
    InviteResult,
} from '@workspace/lib/types/drive-access';
import { parseOwnerId } from '@workspace/lib/types/owner';
import { validateEmailAddress } from '@workspace/lib/validation';
import { getServerSettings } from '../config/server-settings';
import { ApiError } from '../core';
import { composeCollaboratorsEmail } from '../mailer/mail-composers';
import { sendMail } from '../mailer/mailer';
import type { Mount } from '../mount';
import { getEntriesForTarget } from '../share';
import type { User } from '../user';
import { getUserByEmail } from '../user';
import { canonicalACLId, grantsPublicRead, isTrashedChain } from './acl';
import { addEffectiveMember, resolveACLToEmails } from './acl-propagation';
import type { Drive } from './drive';

// Takes the paths whose ACLs count, the breadcrumb first, so a caller that read one already reads no second. A
// path in the trash is its owner's alone, so the ACLs of its chain let nobody else in until the restore.
export async function membersFromCrumbs(owner: User, crumbs: readonly DrivePath[]): Promise<EffectiveMember[]> {
    const allACL = isTrashedChain(crumbs) ? [] : crumbs.flatMap((crumb) => crumb.acl ?? []);

    // Every member of a team has full access to the team's drive. So the team goes in as one more
    // ACL entry, and resolveACLToEmails turns it into its members.
    const parsed = parseOwnerId(owner.id);
    if (parsed.type === 'team') {
        allACL.push({ id: owner.id, read: true, write: true });
    }

    const members = await resolveACLToEmails(allACL);
    if (parsed.type !== 'team' && owner.email) {
        addEffectiveMember(members, owner.email, true, true);
    }
    return [...members.values()];
}

// For the dialog that mails a link: for each address, whether that person can already read the path and whether an
// admin must let them in as a guest first. The owner may always share.
export async function checkAccessForEmails(
    owner: User,
    mount: Mount,
    pathId: string,
    emails: readonly string[],
): Promise<DriveAccessCheckResult> {
    // An empty breadcrumb means the path is gone.
    const crumbs = await mount.getBreadcrumb(pathId);
    if (crumbs.length === 0) throw new ApiError(404, 'Path not found');

    const members = await membersFromCrumbs(owner, crumbs);
    const memberByEmail = new Map(members.map((m) => [m.email, m]));
    const ancestorPublic = !isTrashedChain(crumbs) && crumbs.some((crumb) => grantsPublicRead(crumb.visibility));
    const openSignup = getServerSettings().guests.openSignup;

    const recipients: DriveAccessRecipient[] = [];
    const seen = new Set<string>();
    for (const rawEmail of emails) {
        const email = rawEmail.toLowerCase();
        // Sending accepts some addresses that sharing refuses, such as a domain without a dot.
        // Sharing with those would only fail.
        if (!validateEmailAddress(email) || seen.has(email)) continue;
        seen.add(email);
        // An entry may grant write without read, so only the read flag counts here.
        const hasReadAccess = ancestorPublic || (memberByEmail.get(email)?.read ?? false);
        // Only an unknown address can need an admin, and only when signup is closed.
        let needsGuestAdmission = false;
        if (!openSignup && !(await getUserByEmail(email))) {
            needsGuestAdmission = (await getEntriesForTarget(email)).length === 0;
        }
        recipients.push({ email, hasReadAccess, needsGuestAdmission });
    }

    return { canShare: true, recipients };
}

export async function emailCollaborators(
    drive: Drive,
    mountId: string,
    pathId: string,
    subject: string | null,
    message: string,
    sendCopyToSelf: boolean,
    sender: User,
): Promise<{ sent: number }> {
    const path = await drive.getPath(mountId, pathId);
    if (!path) throw new ApiError(404, 'Path not found');

    const members = await drive.getEffectiveMembers(mountId, pathId);
    const self = sender.email.toLowerCase();
    const recipients = members.filter((m) => sendCopyToSelf || m.email !== self);

    const results = await Promise.allSettled(
        recipients.map((member) => sendMail(composeCollaboratorsEmail(path, subject, message, sender, member.email))),
    );
    return { sent: results.filter((r) => r.status === 'fulfilled' && r.value).length };
}

// Gives someone access to a chat: a chat inside a document shares the document, whose ACL is the one that counts.
// A checked target is shared as it is, so a move in between can't share a document nobody checked.
export async function inviteToChat(
    drive: Drive,
    mountId: string,
    chatId: string,
    email: string,
    actor: User | null,
    checkedTarget?: DrivePath,
): Promise<InviteResult> {
    if (!validateEmailAddress(email)) {
        throw new ApiError(400, 'Invalid email address');
    }

    let targetPath = checkedTarget;
    if (!targetPath) {
        const chatPath = await drive.getPath(mountId, chatId);
        if (!chatPath) throw new ApiError(404, 'Chat not found');
        targetPath = (await drive.findContainerPath(mountId, chatPath.parentId ?? '')) ?? chatPath;
    }

    const id = canonicalACLId(email);
    if (targetPath.acl?.some((entry) => canonicalACLId(entry.id) === id)) {
        return { alreadyHasAccess: true, targetPathId: targetPath.id };
    }

    await drive.updateACLDelta(
        mountId,
        targetPath.id,
        { add: [{ id, read: true, write: true }] },
        undefined,
        undefined,
        actor,
    );
    return { alreadyHasAccess: false, targetPathId: targetPath.id };
}
