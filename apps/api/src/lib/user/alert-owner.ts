// Alerts for the people who run the server, such as a failed backup, delivered as a notification in their own
// notification center. alertOwner reaches the org owner, alertUser any one user.

import { sendToHome } from '../home/home-relay';
import { getOrgOwner } from './user';

// A repeat of the tag replaces the alert before it, so a failure that keeps happening shows once.
export function alertUser(userId: string, title: string, body: string, tag: string): Promise<void> {
    return sendToHome(userId, {
        type: 'notification',
        notification: { type: 'admin-alert', title, body, tag, coalesce: true },
    });
}

// False when the server has no owner to tell yet.
export async function alertOwner(title: string, body: string, tag: string): Promise<boolean> {
    const owner = await getOrgOwner();
    if (!owner) return false;
    await alertUser(owner.id, title, body, tag);
    return true;
}
