import { parseOwnerId } from '@workspace/lib/types';
import { stripEigenExtension } from '@workspace/lib/types/drive';
import { getServerSettings } from '../config/server-settings';
import { composeAccessRequestEmail } from '../core/mail-composers';
import { sendMail } from '../core/mailer';
import type { Home } from '../home';
import { sendToHome } from '../home/home-relay';

export async function propagateAccessRequest(
    home: Home,
    mountId: string,
    pathId: string,
    requester: { name: string; email: string },
    message: string | null,
): Promise<void> {
    const path = await home.drive.getPath(mountId, pathId);
    if (!path || path.trashedAt) return;

    const requesterName = requester.name || requester.email;
    await sendToHome(home.user.id, {
        type: 'notification',
        notification: {
            type: 'access-request',
            tag: `access-request:${home.user.id}:${mountId}:${pathId}:${requester.email}`,
            title: `${requesterName} requested access to "${stripEigenExtension(path.name)}"`,
            body: message,
            actorEmail: requester.email,
        },
    });

    if (parseOwnerId(home.user.id).type === 'user' && getServerSettings().notifications.email.ownerOnAccessRequest) {
        const mail = composeAccessRequestEmail(
            path,
            { name: home.user.name, email: home.user.email },
            { name: requesterName, email: requester.email },
            message,
        );
        sendMail(mail).catch((err) => console.error('Failed to send access-request email:', err));
    }
}
