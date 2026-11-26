// The way a route gets at a drive. The owner gets their own Drive. Anyone else who is signed in gets a
// SharedDrive, which checks their access before every call. A visitor without a login gets a LinkDrive,
// which reads only what a public link opens. What a caller may do with a path, signed in or not, is answered here too,
// whether they sync it over the collab socket, and at which priority a transform for them runs.

import type { DrivePath } from '@workspace/lib/types/drive';
import type { DrivePathPermissions } from '@workspace/lib/types/drive-access';
import type { TransformPriority } from '../document/transform/runner';
import { getHome } from '../home';
import type { User } from '../user';
import { getMemberships } from '../user';
import { canReadByNameFromAncestors } from './acl';
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

export async function getReadDrive(ownerId: string, user: User | null): Promise<DriveLike | LinkDrive> {
    return user ? getSharedDrive(ownerId, user) : getLinkDrive(ownerId);
}

// A visitor never writes, and a member's read and write take the user.
export async function readPermissions(
    ownerId: string,
    mountId: string,
    pathId: string,
    user: User | null,
): Promise<DrivePathPermissions> {
    if (!user) return { canRead: await (await getLinkDrive(ownerId)).canRead(mountId, pathId), canWrite: false };
    const drive = await getSharedDrive(ownerId, user);
    const [canRead, canWrite] = await Promise.all([
        drive.canRead(mountId, pathId, user),
        drive.canWrite(mountId, pathId, user),
    ]);
    return { canRead, canWrite };
}

// A visitor is never live: only someone signed in opens the collab socket.
export async function isLiveReader(
    ownerId: string,
    mountId: string,
    pathId: string,
    user: User | null,
): Promise<boolean> {
    if (!user) return false;
    return (await getSharedDrive(ownerId, user)).isLiveReader(mountId, pathId, user);
}

// An export, or a preview that isn't cached yet, runs at foreground priority only for someone who reads the file by
// name, such as its owner or a person its ACL names. Whoever reads it only through a link or "Anyone signed in", signed
// in or not, waits behind them, so a burst of link views can't take the one transform queue from the people the files
// are shared with.
export async function transformPriorityFor(
    drive: DriveLike | LinkDrive,
    user: User | null,
    path: DrivePath,
): Promise<TransformPriority> {
    if (!user) return 'background';
    const chain = await drive.breadCrumb(path.mountId, path.id);
    return canReadByNameFromAncestors(chain, user, await getMemberships(user.id)) ? 'foreground' : 'background';
}
