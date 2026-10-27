// An org home is the organisation's own folder on the server. It has no drive, mail or calendar of
// its own; it exists so that work done per owner, such as a backup, can treat the organisation like
// any other owner.

import { parseOwnerId } from '@workspace/lib/types/owner';
import { getOrgDataPath, PATHS } from '../config/paths';
import { ApiError, JsonStore } from '../core';
import type { User } from '../user';
import { makeSyntheticUser } from '../user';
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
    public constructor(syntheticUser: User, onClosed?: () => void) {
        super(syntheticUser, getOrgDataPath(parseOwnerId(syntheticUser.id).id), onClosed);
        this.settings = new JsonStore<HomeSettings>(this.fs, PATHS.SETTINGS, {});
    }
}
