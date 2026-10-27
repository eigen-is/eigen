// Tells the owner of a file or folder that someone asks for access. The owner gets a notification in their Home,
// and, if the server settings allow it, an email (to every member for a team). A person who clicks again and again
// does not send a second email within the hour.

import { parseOwnerId } from '@workspace/lib/types';
import { stripEigenExtension } from '@workspace/lib/types/drive';
import { getServerSettings } from '../config/server-settings';
import { WindowLimiter } from '../core/window-limiter';
import { pullDrivePath, pullTeamMembersToNotify, sendToHome } from '../home/home-relay';
import { composeAccessRequestEmail } from '../mailer/mail-composers';
import { sendMail } from '../mailer/mailer';
import { getUserById } from '../user';

// One mail per requester, path and recipient an hour: the notification folds a repeat on its tag, a mail
// cannot.
const mailWindow = new WindowLimiter(60 * 60 * 1000, 1);

export async function propagateAccessRequest(
    ownerId: string,
    mountId: string,
    pathId: string,
    requester: { name: string; email: string },
    message: string | null,
): Promise<void> {
    // The owner's Home is foreign to the caller, so its reads/writes go through the relay seam.
    const path = await pullDrivePath(ownerId, mountId, pathId);
    if (!path || path.trashedAt) return;
    const tag = `access-request:${ownerId}:${mountId}:${pathId}:${requester.email}`;
    const requesterName = requester.name || requester.email;
    // Detached, so the answer doesn't wait on the team's size or tell whether the path exists.
    (async () => {
        await sendToHome(ownerId, {
            type: 'notification',
            notification: {
                type: 'access-request',
                tag,
                title: `${requesterName} requested access`,
                body: stripEigenExtension(path.name),
                actorEmail: requester.email,
                details: { message: message ?? undefined, pathType: path.type },
            },
        });

        if (!getServerSettings().notifications.email.ownerOnAccessRequest) return;
        const recipients =
            parseOwnerId(ownerId).type === 'team'
                ? await pullTeamMembersToNotify(ownerId, requester.email)
                : await getUserById(ownerId).then((owner) => (owner ? [owner] : []));
        // One after another: a team's worth of mails at once would open as many SMTP connections.
        for (const recipient of recipients) {
            const key = `${tag}:${recipient.id}`;
            if (!mailWindow.take(key)) continue;
            const sent = await sendMail(
                composeAccessRequestEmail(path, recipient, { name: requesterName, email: requester.email }, message),
            );
            // The hit holds back clicks while the mail is in flight; a failed send releases it so the next one retries.
            if (!sent) mailWindow.release(key);
        }
    })().catch((err) => console.error('Failed to propagate access request:', err));
}
