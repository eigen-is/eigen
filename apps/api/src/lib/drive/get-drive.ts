// The way a route gets at a drive. The owner gets their own Drive. Anyone else gets a SharedDrive,
// which checks their access before every call.

import { getHome } from '../home';
import type { User } from '../user';
import type { Drive } from './drive';
import { SharedDrive } from './shared-drive';

export type DriveLike = Drive | SharedDrive;

export async function getDrive(user: User): Promise<Drive> {
    const home = await getHome(user.id); // own home
    return home.drive;
}

// The union type is on purpose: a route can only call what both classes have, which is what
// SharedDrive wraps with an access check.
export async function getSharedDrive(ownerId: string, user: User): Promise<DriveLike> {
    if (ownerId === user.id) {
        return getDrive(user);
    }
    const home = await getHome(ownerId); // ownerId-routed: the request is for this owner's home
    return new SharedDrive(home, user);
}
