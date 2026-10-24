import { parseOwnerId } from '@workspace/lib/types';
import { getOrgDataPath } from '../config/paths';
import { ApiError, JsonStore, PATHS } from '../core';
import { makeSyntheticUser, type User } from '../user';
import type { HomeSettings } from './home';
import { Home } from './home';

export function getSyntheticOrgUser(ownerId: string): User {
    const parsed = parseOwnerId(ownerId);
    if (parsed.type !== 'org') {
        throw new ApiError(400, 'Invalid orgId format');
    }
    return makeSyntheticUser(ownerId, ownerId, '');
}

export class OrgHome extends Home {
    public readonly orgId: string;

    public constructor(syntheticUser: User, onClosed?: () => void) {
        const orgId = parseOwnerId(syntheticUser.id).id;
        super(syntheticUser, getOrgDataPath(orgId), onClosed);
        this.orgId = orgId;
        this.settings = new JsonStore<HomeSettings>(this.fs, PATHS.SETTINGS, {});
    }
}
