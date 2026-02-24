import type {User} from 'better-auth/types';
import {getHome} from '../home';
import {getUserById} from '../users/users';
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
    if (ownerId !== user.id) {
        const owner = await getUserById(ownerId);
        if (!owner) {
            throw new ApiError(404, `Owner not found: ${ownerId}`);
        }
        const home = await getHome(owner);
        return new SharedDrive(home, user);
    } else {
        return getDrive(user);
    }
}
