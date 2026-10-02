import { sendToHome } from '../home/home-relay';
import { getOrgOwner } from './user';

// An admin alert in one user's notification center; a repeat of its tag replaces the one before.
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
