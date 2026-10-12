import { parseOwnerId } from '@workspace/lib/types';
import { type DrivePath, stripEigenExtension } from '@workspace/lib/types/drive';
import { getServerSettings } from '../config/server-settings';
import { composeAccessRequestEmail } from '../core/mail-composers';
import { sendMail } from '../core/mailer';
import { WindowLimiter } from '../core/window-limiter';
import { pullDrivePath, pullTeamMembersToNotify, sendToHome } from '../home/home-relay';
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
    // Detached, so the answer doesn't wait on the team's size or tell whether the path exists.
    notifyAccessRequest(ownerId, tag, path, requester, message).catch((err) =>
        console.error('Failed to propagate access request:', err),
    );
}

async function notifyAccessRequest(
    ownerId: string,
    tag: string,
    path: DrivePath,
    requester: { name: string; email: string },
    message: string | null,
): Promise<void> {
    const requesterName = requester.name || requester.email;
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
    await Promise.all(
        recipients.map(async (recipient) => {
            const key = `${tag}:${recipient.id}`;
            if (!mailWindow.take(key)) return;
            const sent = await sendMail(
                composeAccessRequestEmail(path, recipient, { name: requesterName, email: requester.email }, message),
            );
            // The hit holds back clicks while the mail is in flight; a failed send releases it so the next one retries.
            if (!sent) mailWindow.release(key);
        }),
    );
}
