import type { Snapshot } from '@workspace/lib/types/versioning';
import { ApiError } from '../core';
import type { Mount } from '../mount/mount';
import { DEFAULT_RETENTION, type RetentionPolicy } from './retention';
import { parseSnapshotTimestamp } from './timestamp';

export async function saveVersion(
    mount: Mount,
    containerId: string,
    policy: RetentionPolicy = DEFAULT_RETENTION,
): Promise<Snapshot> {
    const created = await mount.withPathLock(containerId, () => mount.snapshotContainerDataDb(containerId, policy));
    const createdAt = parseSnapshotTimestamp(created.name);
    if (!createdAt) throw new ApiError(500, `snapshot name ${created.name} unparseable`);
    return { id: created.id, name: created.name, createdAt, size: created.size };
}
