import { parseOwnerId } from '@workspace/lib/types';
import { stripEigenExtension } from '@workspace/lib/types/drive';
import { getServerSettings } from '../config/server-settings';
import { composeAccessRequestEmail } from '../core/mail-composers';
import { sendMail } from '../core/mailer';
import { WindowLimiter } from '../core/window-limiter';
import { pullDrivePath, sendToHome } from '../home/home-relay';
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

    if (parseOwnerId(ownerId).type === 'user' && getServerSettings().notifications.email.ownerOnAccessRequest) {
        if (!mailWindow.take(tag)) return;
        const owner = await getUserById(ownerId);
        if (!owner) return;
        const mail = composeAccessRequestEmail(
            path,
            { name: owner.name, email: owner.email },
            { name: requesterName, email: requester.email },
            message,
        );
        // The hit holds back clicks while the mail is in flight; a failed send releases it so the next one retries.
        sendMail(mail)
            .then((sent) => {
                if (!sent) mailWindow.release(tag);
            })
            .catch((err) => console.error('Failed to send access-request email:', err));
    }
}
