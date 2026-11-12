import type { MountConfig } from '@workspace/lib/types';
import type { DrivePath } from '@workspace/lib/types/drive';
import { getS3Config } from '../lib/config/server-settings';
import type { Drive } from '../lib/drive';
import type { Mount } from '../lib/mount';
import { writeTempWithHash } from '../lib/storage';

// A default mount under a per-test id and backend. Production's createDefaultMountConfig only ever
// builds the real 'default' mount, so the id/storageType knobs the fixtures need live here.
export function createTestMountConfig(id: string, storageType: MountConfig['storageType'] = 'local'): MountConfig {
    return {
        id,
        name: id,
        storageType,
        isDefault: true,
        s3Config: storageType === 's3' ? getS3Config() : undefined,
    };
}

// A new file straight on a mount, made the way an upload makes one: the bytes go to a temp file first.
// `size` is what the row says, which a test of a size cap sets past the bytes it stores.
export async function seedFile(
    mount: Mount,
    parentId: string,
    name: string,
    mimeType: string,
    size: number,
    data: Buffer | Uint8Array,
): Promise<string> {
    const tempId = crypto.randomUUID();
    try {
        const { hash } = await writeTempWithHash(mount.getTempPath(tempId), data);
        return await mount.createFileFromTemp(parentId, name, mimeType, size, hash, tempId);
    } finally {
        await mount.cleanupTemp(tempId);
    }
}

// New bytes for a file straight on a mount, the way a content write puts them there.
export async function overwriteFile(mount: Mount, pathId: string, data: Buffer, ifMatch?: string): Promise<DrivePath> {
    const tempId = crypto.randomUUID();
    try {
        const { size, hash } = await writeTempWithHash(mount.getTempPath(tempId), data);
        return await mount.writeFileFromTemp(pathId, tempId, size, hash, ifMatch);
    } finally {
        await mount.cleanupTemp(tempId);
    }
}

// Waits until every mount of the drive has indexed its changed files. The index catches up by itself,
// so only a test waits for it.
export async function flushContentReindex(drive: Drive): Promise<void> {
    for (const mount of drive.getMounts()) await mount.reindexQueue?.drain();
}

// Mount.copyPath records who copied each path, so a copy straight on a mount needs someone to name.
export const TEST_ACTOR = { id: 'test-actor', email: 'actor@test.eigen.is' };
