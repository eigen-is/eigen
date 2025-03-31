import { getHome } from "../home/home";
import {getUserByEmail, getUserById} from "../users/users";

export async function getPublicInfo(mailOrId: string) {
    // detect if mail or id?
    const isMail = mailOrId.includes('@');
    const user = await (isMail ? getUserByEmail(mailOrId) : getUserById(mailOrId));
    let image = user?.image || false;
    if (user && image) {
        // get filename from path
        const filename = image.split('/').pop();
        image = `${process.env['VITE_API_HOST']}/space/avatar/${user.id}/${filename}`;
    }
    return {
        name: user?.name,
        email: user?.email,
        image: image || null,
    };
}

export async function getAvatar(userId: string, filename: string) {
    const user = await getUserById(userId);
    if (!user) {
        return null;
    }
    const home = await getHome(user);
    const file = home.fs.file(`eigen.contacts/avatars/${filename}`);
    if (await file.exists()) {
        return file.arrayBuffer();
    } else {
        return null;
    }
}