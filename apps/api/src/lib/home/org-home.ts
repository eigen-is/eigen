import { parseOwnerId } from '@workspace/lib/types';
import type { User } from 'better-auth/types';
import { getOrgDataPath } from '../config/paths';
import { ApiError, LocalFilesystem } from '../core';
import { Home } from './home';

export function getSyntheticOrgUser(ownerId: string): User {
    const parsed = parseOwnerId(ownerId);
    if (!parsed || parsed.type !== 'org') {
        throw new ApiError(400, 'Invalid orgId format');
    }

    return {
        id: ownerId,
        name: ownerId,
        email: '',
        emailVerified: false,
        createdAt: new Date(),
        updatedAt: new Date(),
    };
}

export class OrgHome extends Home {
    public orgId: string;

    constructor(syntheticUser: User, cleanUp?: () => void) {
        super(syntheticUser, cleanUp);

        const parsed = parseOwnerId(syntheticUser.id);
        this.orgId = parsed.id;
        this.homeDir = getOrgDataPath(parsed.id);
        this.fs = new LocalFilesystem(this.homeDir);
    }
}
