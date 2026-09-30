import { parseOwnerId } from '@workspace/lib/types/owner';
import { getTeamDataPath, getUserHomePath } from '../config/paths';
import { ApiError } from '../core/errors';
import { getUserById } from '../user/user';
import { type BackableOwner, requireBackableOwner } from './paths';

// The owner an ownerId names, once it is one a backup can be of. The guest refusal needs the user
// row, which is why this is the async half of requireBackableOwner; the routes and the folder
// resolver both go through it, so the refusal is spelled once.
export async function requireBackableHome(ownerId: string): Promise<BackableOwner> {
    const owner = parseOwnerId(ownerId);
    requireBackableOwner(owner);
    if (owner.type === 'user' && (await getUserById(owner.id))?.role === 'guest') {
        throw new ApiError(400, 'Guest homes are not backed up');
    }
    return owner;
}

// Where this owner's home folder lives.
export async function resolveHomeDir(ownerId: string): Promise<string> {
    const owner = await requireBackableHome(ownerId);
    return owner.type === 'team' ? getTeamDataPath(owner.id) : getUserHomePath(owner.id);
}
