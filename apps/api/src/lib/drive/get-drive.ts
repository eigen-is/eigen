import type {User} from 'better-auth/types';
import {getHome} from '../home';
import Drive from './drive';
import SharedDrive from './sharedDrive';
import {ApiError} from '../core/errors';

export async function getDrive(user: User): Promise<Drive> {
    const home = await getHome(user.id);
    return home.drive;
}

export async function getSharedDrive(ownerId: string, user: User): Promise<Drive> {
    if (!user?.id) {
        throw new ApiError(401, 'User is required');
    }

    if (ownerId !== user.id) {
        const home = await getHome(ownerId);
        return new SharedDrive(home, user);
    } else {
        return getDrive(user);
    }

}
