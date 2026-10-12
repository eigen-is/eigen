import { parseOwnerId } from '@workspace/lib/types';
import { stripEigenExtension } from '@workspace/lib/types/drive';
import { getServerSettings } from '../config/server-settings';
import { composeAccessRequestEmail } from '../core/mail-composers';
import { sendMail } from '../core/mailer';
import { WindowLimiter } from '../core/window-limiter';
import { pullDrivePath, pullTeamMembersToNotify, sendToHome } from '../home/home-relay';
import { getUserById } from '../user';

// One mail per requester and path an hour: the owner's notification folds a repeat on its tag, a mail
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

    const requesterName = requester.name || requester.email;
    const tag = `access-request:${ownerId}:${mountId}:${pathId}:${requester.email}`;
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
    if (recipients.length === 0 || !mailWindow.take(tag)) return;
    // The hit holds back clicks while the mails are in flight; released only when every send failed, so the next one retries.
    Promise.all(
        recipients.map((recipient) =>
            sendMail(
                composeAccessRequestEmail(path, recipient, { name: requesterName, email: requester.email }, message),
            ),
        ),
    )
        .then((sent) => {
            if (!sent.includes(true)) mailWindow.release(tag);
        })
        .catch((err) => console.error('Failed to send access-request email:', err));
}
