import * as path from 'node:path';
import { parseOwnerId, teamOwnerId } from '@workspace/lib/types';
import type { PublicUser } from '@workspace/lib/types/public';
import { validateEmailAddress } from '@workspace/lib/validation';
import type { BunFile } from 'bun';
import { getAvatarsDir } from '../config/paths';
import { ApiError } from '../core';
import { getTeam, getTeamExists } from '../team';
import type { User } from '../user';
import { getUserByEmail, getUserById } from '../user/';

export async function getUserByEmailOrId(emailOrId: string): Promise<User | null> {
    return validateEmailAddress(emailOrId) ? getUserByEmail(emailOrId) : getUserById(emailOrId);
}

export async function getPublicInfo(emailOrId: string): Promise<PublicUser> {
    const parsed = parseOwnerId(emailOrId);
    if (parsed.type === 'team') {
        const team = await getTeam(parsed.id);
        if (team)
            return {
                name: team.name,
                email: '',
                avatar: `p/avatar/${emailOrId}`,
            };
    } else {
        const user = await getUserByEmailOrId(emailOrId);
        if (user)
            return {
                name: user.name,
                email: user.email,
                avatar: `p/avatar/${user.id}`,
            };
    }
    throw new ApiError(404, 'User not found');
}

export async function getBatchPublicInfo(ids: string[]): Promise<Record<string, PublicUser>> {
    const result: Record<string, PublicUser> = {};
    await Promise.all(
        ids.map(async (id) => {
            try {
                result[id] = await getPublicInfo(id);
            } catch {
                // Skip users that can't be resolved
            }
        }),
    );
    return result;
}

export async function getAvatarByEmailOrId(emailOrId: string): Promise<BunFile | null> {
    const parsed = parseOwnerId(emailOrId);
    if (parsed.type === 'team') {
        // Build the filename from the parsed id, never the raw input — the `team_` owner prefix
        // keeps it clear of user UUIDs. Existence is the only source of truth. Cheap file check
        // first: most teams have no avatar, so skip the team lookup unless there's actually a
        // file that must not be served for a deleted team.
        const file = Bun.file(path.join(getAvatarsDir(), `${teamOwnerId(parsed.id)}.webp`));
        if (!(await file.exists())) return null;
        return (await getTeamExists(parsed.id)) ? file : null;
    }

    const user = await getUserByEmailOrId(emailOrId);
    if (!user) return null;

    const file = Bun.file(path.join(getAvatarsDir(), `${user.id}.webp`));
    return (await file.exists()) ? file : null;
}

export async function generateFallbackSvg(emailOrId: string): Promise<string> {
    const parsed = parseOwnerId(emailOrId);
    const user = await getUserByEmailOrId(emailOrId);

    const id = user?.email || emailOrId;

    let hash = 0;
    for (let i = 0; i < id.length; i++) {
        hash = ((hash << 5) - hash + id.charCodeAt(i)) | 0;
    }
    const hue = Math.abs(hash) % 360;
    const color = `hsl(${hue}, 45%, 55%)`;

    if (parsed.type === 'team') {
        return `<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256" viewBox="0 0 256 256">
  <rect width="256" height="256" fill="#f1f5f9"/>
  <g fill="${color}">
    <circle cx="128" cy="128" r="32"/>
    
    <circle cx="128" cy="64" r="32"/>
    <circle cx="128" cy="192" r="32"/>
    
    <circle cx="183.43" cy="96" r="32"/>
    <circle cx="183.43" cy="160" r="32"/>
    
    <circle cx="72.57" cy="96" r="32"/>
    <circle cx="72.57" cy="160" r="32"/>
  </g>
</svg>`;
    } else {
        return `<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256" viewBox="0 0 256 256">
  <rect width="256" height="256" fill="#f1f5f9"/>
  <circle cx="128" cy="128" r="96" fill="${color}"/>
</svg>`;
    }
}
