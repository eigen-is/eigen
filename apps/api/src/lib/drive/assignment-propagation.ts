// Tells the person a comment or card was just assigned to. If the server settings allow it for their kind, guest or
// user, they get an email, at most one an hour per document, and with an account a notification in their Home. An
// address with no account counts as a guest.

import { commentAssignedTag } from '@workspace/lib/notification/tags';
import type { DrivePath } from '@workspace/lib/types/drive';
import { stripEigenExtension } from '@workspace/lib/types/drive';
import { getServerSettings } from '../config/server-settings';
import { WindowLimiter } from '../core/window-limiter';
import { sendToHome } from '../home/home-relay';
import { composeAssignedEmail } from '../mailer/mail-composers';
import { sendMail } from '../mailer/mailer';
import type { User } from '../user';
import { getUserByEmail, isGuest } from '../user';

// One mail per person and document an hour: a notification folds a repeat on its tag, a mail cannot.
const assignMailWindow = new WindowLimiter(60 * 60 * 1000, 1);

export async function propagateAssignment(
    path: DrivePath,
    chatName: string,
    assignee: string,
    actor: User,
    card: string | undefined,
): Promise<void> {
    const assigneeUser = await getUserByEmail(assignee);
    const { guestOnAssign, userOnAssign } = getServerSettings().notifications.email;
    const toGuest = !assigneeUser || isGuest(assigneeUser);
    const key = `${assignee}:${path.ownerId}:${path.mountId}:${path.id}`;
    // Sent before the notification, so a home that refuses it can't stop the mail, and not awaited, so a slow mail
    // relay can't hold the route.
    if ((toGuest ? guestOnAssign : userOnAssign) && assignMailWindow.take(key)) {
        sendMail(composeAssignedEmail(path, assignee, actor, chatName, card))
            .then((sent) => {
                if (!sent) assignMailWindow.release(key);
            })
            .catch((err) => console.error('Failed to send assignment email:', err));
    }

    if (!assigneeUser) return;
    await sendToHome(assigneeUser.id, {
        type: 'notification',
        notification: {
            type: 'assigned',
            actorEmail: actor.email,
            title: `${actor.name || actor.email} assigned you a task on "${stripEigenExtension(path.name)}"`,
            tag: commentAssignedTag({ ownerId: path.ownerId, mountId: path.mountId, pathId: path.id, chatName }),
            details: { pathType: path.type },
        },
    });
}
