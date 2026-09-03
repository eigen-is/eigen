import { getHome } from '../home';
import type { User } from '../user';
import type Drive from './drive';
import SharedDrive from './sharedDrive';

export type DriveLike = Drive | SharedDrive;

export async function getDrive(user: User): Promise<Drive> {
    const home = await getHome(user.id); // own home
    return home.drive;
}

// Returns the union `Drive | SharedDrive` so route callers can only invoke methods present on
// both classes — i.e., the explicit ACL-wrapped surface on SharedDrive. New methods on Drive
// without a matching SharedDrive wrapper are not in the intersection and become unreachable
// from routes (TS error). See SharedDrive's class comment.
export async function getSharedDrive(ownerId: string, user: User): Promise<DriveLike> {
    if (ownerId === user.id) {
        // Owner accesses own home directly — no ACL wrapper, no overhead.
        return getDrive(user);
    }
    const home = await getHome(ownerId); // ownerId-routed: request targets this home
    return new SharedDrive(home, user);
}
