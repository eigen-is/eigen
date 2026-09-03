import type { Snapshot } from '@workspace/lib/types/versioning';
import type { Mount } from '../mount/mount';
import { parseSnapshotTimestamp } from './timestamp';
import { VERSIONS_FOLDER_NAME } from './versions-folder';

export async function listVersions(mount: Mount, containerId: string): Promise<Snapshot[]> {
    const versions = await mount.getChildByName(containerId, VERSIONS_FOLDER_NAME);
    if (!versions) return [];
    const files = await mount.listFolder(versions.id);
    return files
        .map((f) => {
            const ts = parseSnapshotTimestamp(f.name);
            return ts ? { id: f.id, name: f.name, createdAt: ts, size: f.size } : null;
        })
        .filter((s): s is Snapshot => s !== null)
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
}
