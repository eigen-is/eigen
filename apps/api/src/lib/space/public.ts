import type {PublicUser} from "@workspace/lib/types/public";
import {getHome} from "../home";
import {getUserByEmail, getUserById} from "../users/users";
import type {User} from "better-auth/types";

export async function getUserByEmailOrId(emailOrId: string): Promise<User | null> {
    const isMail = emailOrId.includes('@');
    return (isMail ? getUserByEmail(emailOrId) : getUserById(emailOrId));
}

export async function getPublicInfo(emailOrId: string): Promise<PublicUser | null> {
    const user = await getUserByEmailOrId(emailOrId);
    return user ? {
        name: user?.name,
        email: user?.email,
    } : null;
}

export async function getAvatarByEmailOrId(emailOrId: string): Promise<ArrayBuffer | null> {
    const user = await getUserByEmailOrId(emailOrId);
    if (!user?.image) return null;

    const filename = user.image.split('/').pop();
    if (!filename) return null;

    const home = await getHome(user);
    const file = home.fs.file(`eigen.contacts/avatars/${filename}`);
    if (await file.exists()) {
        return file.arrayBuffer();
    }
    return null;
}

export async function generateFallbackSvg(emailOrId: string): Promise<string> {
    const user = await getUserByEmailOrId(emailOrId);
    console.log(emailOrId, user?.id);
    const id = user?.email || emailOrId;

    let hash = 0;
    for (let i = 0; i < id.length; i++) {
        hash = ((hash << 5) - hash + id.charCodeAt(i)) | 0;
    }
    const hue = Math.abs(hash) % 360;
    const color = `hsl(${hue}, 45%, 55%)`;

    return `<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256" viewBox="0 0 256 256">
  <rect width="256" height="256" fill="#e5e5e5"/>
  <circle cx="128" cy="128" r="96" fill="${color}"/>
</svg>`;
}