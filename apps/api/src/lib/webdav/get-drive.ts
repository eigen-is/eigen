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
    // DbUser (auth-schema row) and User (better-auth/types) differ in nullability on a
    // few fields, but the runtime shape carries the id/email/name that downstream ACL
    // and home lookups read.
    return getSharedDrive(ownerId, dbUser as unknown as User);
}
