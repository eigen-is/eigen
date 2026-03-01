import type {PublicUser} from "@workspace/lib/types/public";
import {getHome} from "../home";
import {getUserByEmail, getUserById} from "../user/";
import type {User} from "better-auth/types";
import { parseOwnerId } from "@workspace/lib/types";

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

    const home = await getHome(user.id);
    const file = home.fs.file(`eigen.contacts/avatars/${filename}`);
    if (await file.exists()) {
        return file.arrayBuffer();
    }
    return null;
}

export async function generateFallbackSvg(emailOrId: string): Promise<string> {
// if emailOrId === team
const parsed = parseOwnerId(emailOrId);
if (parsed.type === 'team') {
    // TODO: generate team avatar
    return `<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40" viewBox="0 0 40 40" background="#e5e5e5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-users h-4 w-4">
    <g transform="translate(8, 8)">
    <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"></path><circle cx="9" cy="7" r="4"></circle><path d="M22 21v-2a4 4 0 0 0-3-3.87"></path><path d="M16 3.13a4 4 0 0 1 0 7.75"></path>
    </g></svg>`;
}

    const user = await getUserByEmailOrId(emailOrId);

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