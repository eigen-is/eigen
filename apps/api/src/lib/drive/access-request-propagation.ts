// Tells the owner of a file or folder that someone asks for access. The owner gets a notification in their Home,
// and, if the server settings allow it, an email (to every member for a team). A person who clicks again and again
// does not send a second email within the hour. The access-request route opens the owner's Home and passes it in.

import { accessRequestTag } from '@workspace/lib/notification/tags';
import { stripEigenExtension } from '@workspace/lib/types/drive';
import { getServerSettings } from '../config/server-settings';
import { WindowLimiter } from '../core/window-limiter';
import type { Home } from '../home';
import { TeamHome } from '../home';
import { pushToHomes } from '../home/home-relay';
import { composeAccessRequestEmail } from '../mailer/mail-composers';
import { sendMail } from '../mailer/mailer';
import type { User } from '../user';
import { getUserById } from '../user';

// One mail per requester, path and recipient an hour: the notification folds a repeat on its tag, a mail
// cannot.
const mailWindow = new WindowLimiter(60 * 60 * 1000, 1);

export async function propagateAccessRequest(
    home: Home,
    mountId: string,
    pathId: string,
    requester: User,
    message: string | null,
): Promise<void> {
    const path = await home.drive.getPath(mountId, pathId);
    if (!path || path.trashedAt) return;
    const ownerId = home.user.id;
    const tag = accessRequestTag({ ownerId, mountId, pathId }, requester.email);
    // Detached, so the answer doesn't wait on the team's size or tell whether the path exists. It needs no hold on
    // the Home: past this point it reads only memory and the auth database.
    (async () => {
        await pushToHomes([ownerId], {
            type: 'notification',
            notification: {
                type: 'access-request',
                tag,
                title: `${requester.name || requester.email} requested access`,
                body: stripEigenExtension(path.name),
                actorEmail: requester.email,
                details: { message: message ?? undefined, pathType: path.type },
            },
        });

        if (!getServerSettings().notifications.email.ownerOnAccessRequest) return;
        // Read again: the Home's user is the row as it was when the Home opened.
        const recipients =
            home instanceof TeamHome
                ? await home.membersToNotify(requester.email)
                : await getUserById(ownerId).then((owner) => (owner ? [owner] : []));
        // One after another: a team's worth of mails at once would open as many SMTP connections.
        for (const recipient of recipients) {
            const key = `${tag}:${recipient.id}`;
            if (!mailWindow.take(key)) continue;
            const sent = await sendMail(composeAccessRequestEmail(path, recipient, requester, message));
            // The hit holds back clicks while the mail is in flight; a failed send releases it so the next one retries.
            if (!sent) mailWindow.release(key);
        }
    })().catch((err) => console.error('Failed to propagate access request:', err));
}
