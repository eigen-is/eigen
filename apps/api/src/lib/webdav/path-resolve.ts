import type { DrivePath } from '@workspace/lib/types/drive';
import type Drive from '../drive/drive';
import type SharedDrive from '../drive/sharedDrive';

export type DriveLike = Drive | SharedDrive;

export class WebdavPathCache {
    private cache = new Map<string, DrivePath | null>();

    async resolve(drive: DriveLike, mountId: string, pathStr: string): Promise<DrivePath | null> {
        const key = `${mountId}:${pathStr}`;
        const cached = this.cache.get(key);
        if (cached !== undefined) return cached;
        const path = await drive.resolvePath(mountId, pathStr);
        this.cache.set(key, path);
        return path;
    }
}
