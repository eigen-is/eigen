// The way a route gets at a drive. The owner gets their own Drive. Anyone else who is signed in gets a
// SharedDrive, which checks their access before every call. A visitor without a login gets a LinkDrive,
// which reads only what a public link opens.

import { getHome } from '../home';
import type { User } from '../user';
import type { Drive } from './drive';
import { LinkDrive } from './link-drive';
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

// A visitor has no home of their own, so the request opens only the home its URL names.
export async function getLinkDrive(ownerId: string): Promise<LinkDrive> {
    const home = await getHome(ownerId); // ownerId-routed: the request is for this owner's home
    return new LinkDrive(home);
}
