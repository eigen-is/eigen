// Which homes a backup may be of, and where such a home's folder lives. The backup routes and the folder resolver
// both ask requireBackableHome, so a guest's home is refused in one place.

import { parseOwnerId } from '@workspace/lib/types/owner';
import { getDataRoot, homeDirUnder } from '../config/paths';
import { ApiError } from '../core/errors';
import { getUserById, isGuest } from '../user/user';
import type { BackableOwner } from './paths';
import { requireBackableOwner } from './paths';

// The owner an ownerId names, once it is one a backup can be of. The guest refusal needs the user
// row, which is why this is the async half of requireBackableOwner; the routes and the folder
// resolver both go through it, so the refusal is spelled once.
export async function requireBackableHome(ownerId: string): Promise<BackableOwner> {
    const owner = parseOwnerId(ownerId);
    requireBackableOwner(owner);
    if (owner.type === 'user' && isGuest(await getUserById(owner.id))) {
        throw new ApiError(400, 'Guest homes are not backed up');
    }
    return owner;
}

// Where this owner's home folder lives.
export async function resolveHomeDir(ownerId: string): Promise<string> {
    await requireBackableHome(ownerId);
    return homeDirUnder(getDataRoot(), ownerId);
}
