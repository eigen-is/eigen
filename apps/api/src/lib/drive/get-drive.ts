import type {User} from 'better-auth/types';
import {getHome} from '../home';
import {getUserById} from '../users/users';
import Drive from './drive';
import SharedDrive from './sharedDrive';

export async function getDrive(user: User): Promise<Drive> {
    const home = await getHome(user);
    return home.drive;
}

export async function getSharedDrive(ownerId: string, user: User) {
    if (!user?.id) {
        throw new Error('User is required');
    }
    if (ownerId !== user.id) {
        const owner = await getUserById(ownerId);
        const home = await getHome(owner as User);
        return new SharedDrive(home, user);
    } else {
        return getDrive(user);
    }
}
