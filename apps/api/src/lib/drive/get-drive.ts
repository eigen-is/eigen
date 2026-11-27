// The way a route gets at a drive. The owner gets their own Drive. Anyone else who is signed in gets a
// SharedDrive, which checks their access before every call. A visitor without a login gets a LinkDrive,
// which reads only what a public link opens. What a caller may do with a path, signed in or not, is answered here too,
// such as whether they sync it over the collab socket.

import { getHome } from '../home';
import type { User } from '../user';
import type { ReaderAccess } from './acl';
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

// A visitor has no home of their own, so a LinkDrive opens only the home its URL names, and none while public links
// are off.
export async function getReadDrive(ownerId: string, user: User | null): Promise<DriveLike | LinkDrive> {
    return user ? getSharedDrive(ownerId, user) : getLinkDrive(ownerId);
}

function getLinkDrive(ownerId: string): LinkDrive {
    // ownerId-routed: the request is for this owner's home
    return new LinkDrive(async () => (await getHome(ownerId)).drive);
}

// A visitor never writes, syncs nothing over the collab socket and waits behind every reader by name.
export async function getReaderAccess(
    ownerId: string,
    mountId: string,
    pathId: string,
    user: User | null,
): Promise<ReaderAccess> {
    if (user) return (await getSharedDrive(ownerId, user)).readerAccess(mountId, pathId, user);
    const canRead = await getLinkDrive(ownerId).canRead(mountId, pathId);
    return { canRead, canWrite: false, live: false, priority: 'background' };
}
