import type {User} from 'better-auth/types';
import type {PathEntry, ACLEntry} from '../mount/types';

export type PathGetter = (pathId: string) => Promise<PathEntry | null>;

export async function canRead(
    path: PathEntry,
    user: User,
    getPath: PathGetter
): Promise<boolean> {
    if (path.ownerId === user.id) {
        return true;
    }

    if (path.acl && path.acl.length > 0) {
        const userAcl = path.acl.find(a => a.email.toLowerCase() === user.email.toLowerCase());
        if (userAcl) {
            return userAcl.read || userAcl.public === true;
        }

        const publicAcl = path.acl.find(a => a.public);
        if (publicAcl) {
            return true;
        }
    } else if (path.parentId) {
        const parent = await getPath(path.parentId);
        if (parent) {
            return canRead(parent, user, getPath);
        }
    }

    return path.ownerId === user.id;
}

export async function canWrite(
    path: PathEntry,
    user: User,
    getPath: PathGetter
): Promise<boolean> {
    if (path.ownerId === user.id) {
        return true;
    }

    if (path.acl && path.acl.length > 0) {
        const userAcl = path.acl.find(a => a.email.toLowerCase() === user.email.toLowerCase());
        if (userAcl) {
            return userAcl.write;
        }
    } else if (path.parentId) {
        const parent = await getPath(path.parentId);
        if (parent) {
            return canWrite(parent, user, getPath);
        }
    }

    return path.ownerId === user.id;
}

export function getEffectiveACL(
    path: PathEntry,
    getPath: (pathId: string) => PathEntry | null
): ACLEntry[] | null {
    if (path.acl && path.acl.length > 0) {
        return path.acl;
    }

    if (path.parentId) {
        const parent = getPath(path.parentId);
        if (parent) {
            return getEffectiveACL(parent, getPath);
        }
    }

    return null;
}

export function normalizeACL(acl: ACLEntry[] | null): ACLEntry[] | null {
    if (!acl || acl.length === 0) {
        return null;
    }

    return acl.map(a => ({
        ...a,
        email: a.email.toLowerCase()
    }));
}
