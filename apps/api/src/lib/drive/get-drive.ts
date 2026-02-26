import type {User} from 'better-auth/types';
import {getHome, getTeamHome} from '../home';
import {getUserById} from '../users/users';
import {parseOwnerId} from '@workspace/lib/types';
import Drive from './drive';
import SharedDrive from './sharedDrive';
import {ApiError} from '../core/errors';

export async function getDrive(user: User): Promise<Drive> {
    const home = await getHome(user);
    return home.drive;
}

export async function getSharedDrive(ownerId: string, user: User) {
    if (!user?.id) {
        throw new ApiError(401, 'User is required');
    }

    const parsed = parseOwnerId(ownerId);

    switch (parsed.type) {
        case 'user': {
            if (parsed.id !== user.id) {
                const owner = await getUserById(parsed.id);
                if (!owner) {
                    throw new ApiError(404, `Owner not found: ${ownerId}`);
                }
                const home = await getHome(owner);
                return new SharedDrive(home, user);
            } else {
                return getDrive(user);
            }
        }
        case 'team': {
            const teamHome = await getTeamHome(parsed.id);
            return teamHome.drive;
        }
    }
}
