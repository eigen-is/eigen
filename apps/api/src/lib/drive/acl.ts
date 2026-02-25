import type {User} from 'better-auth/types';
import type {DriveACL, DrivePath} from '@workspace/lib/types/drive';

export type PathGetter = (pathId: string) => Promise<DrivePath | null>;

export async function canRead(
    path: DrivePath,
    user: User,
    getPath: PathGetter
): Promise<boolean> {
    if (path.ownerId === user.id) return true;
    if (path.visibility === 'public-read' || path.visibility === 'public-write') return true;

    const userAcl = path.acl?.find(a => a.email.toLowerCase() === user.email.toLowerCase());
    if (userAcl?.read) return true;

    if (path.parentId) {
        const parent = await getPath(path.parentId);
        if (parent) return canRead(parent, user, getPath);
    }

    return false;
}

export async function canWrite(
    path: DrivePath,
    user: User,
    getPath: PathGetter
): Promise<boolean> {
    if (path.ownerId === user.id) return true;
    if (path.visibility === 'public-write') return true;

    const userAcl = path.acl?.find(a => a.email.toLowerCase() === user.email.toLowerCase());
    if (userAcl?.write) return true;

    if (path.parentId) {
        const parent = await getPath(path.parentId);
        if (parent) return canWrite(parent, user, getPath);
    }

    return false;
}

export function normalizeACL(acl: DriveACL[] | null): DriveACL[] | null {
    if (!acl || acl.length === 0) {
        return null;
    }

    return acl.map(a => ({
        ...a,
        email: a.email.toLowerCase()
    }));
}
