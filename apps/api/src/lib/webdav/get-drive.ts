import type { ProtocolUser } from '../auth/protocol-auth';
import type Drive from '../drive/drive';
import { getSharedDrive } from '../drive/get-drive';
import type SharedDrive from '../drive/sharedDrive';

// `ProtocolUser` is a structural supertype of `AuthSubject` (it has `id` + `email`), so it
// passes through `getSharedDrive` directly — no cast, no User lookup.
export async function getWebdavDrive(ownerId: string, protocolUser: ProtocolUser): Promise<Drive | SharedDrive> {
    return getSharedDrive(ownerId, protocolUser);
}
