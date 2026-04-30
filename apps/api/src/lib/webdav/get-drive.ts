import type { User } from 'better-auth/types';
import type { ProtocolUser } from '../auth/protocol-auth';
import { ApiError } from '../core/errors';
import type Drive from '../drive/drive';
import { getSharedDrive } from '../drive/get-drive';
import type SharedDrive from '../drive/sharedDrive';
import { getUserById } from '../user/user';

export async function getWebdavDrive(ownerId: string, protocolUser: ProtocolUser): Promise<Drive | SharedDrive> {
    const dbUser = await getUserById(protocolUser.id);
    if (!dbUser) throw new ApiError(401, 'Unauthorized');
    // DbUser (better-auth schema row) and User (better-auth/types) have different
    // nullability semantics on a few fields. getSharedDrive/getDrive only read user.id,
    // so the cast is safe at runtime.
    return getSharedDrive(ownerId, dbUser as unknown as User);
}
