import type {PublicUser} from "@workspace/lib/types/public";
import {getHome} from "../home/home";
import {getUserByEmail, getUserById} from "../users/users";

export async function getPublicInfo(mailOrId: string): Promise<PublicUser | null> {
    // detect if mail or id?
    const isMail = mailOrId.includes('@');
    const user = await (isMail ? getUserByEmail(mailOrId) : getUserById(mailOrId));
    let avatar = user?.image || false;
    if (user && avatar) {
        // get filename from path
        const filename = avatar.split('/').pop();
        avatar = `space/${user.id}/avatar/${filename}`;
    }
    return user ? {
        name: user?.name,
        email: user?.email,
        avatar: avatar || undefined,
    } : null;
}

export async function getAvatar(userId: string, filename: string) {
    try {
        const user = await getUserById(userId);
        if (!user) {
            throw new Error('User not found');
        }
        const home = await getHome(user);
        const file = home.fs.file(`eigen.contacts/avatars/${filename}`);
        if (await file.exists()) {
            return file.arrayBuffer();
        } else {
            throw new Error('Avatar not found');
        }
    } catch (e) {
        throw e;
    }
}