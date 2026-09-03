import type { MountConfig } from '@workspace/lib/types';
import { getS3Config } from '../lib/config/server-settings';

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
