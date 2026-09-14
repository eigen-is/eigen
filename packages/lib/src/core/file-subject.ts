import type { DrivePath } from '../types/drive';
import type { FileSubject } from '../types/file-subject';
import { getDriveDownloadUrl, getDriveEmbedUrl, getDriveThumbnailUrl } from './api';

export function subjectFromPath(path: DrivePath): FileSubject {
    // A path that came off a raw fetch rather than through the Eden reviver still carries a string.
    const updated = path.updatedAt instanceof Date ? path.updatedAt : new Date(path.updatedAt);
    return {
        key: `drive:${path.ownerId}:${path.mountId}:${path.id}`,
        name: path.name,
        mimeType: path.mimeType,
        size: path.size,
        embedUrl: getDriveEmbedUrl(path.ownerId, path.mountId, path.id, path.name, updated),
        // Only a plain file has bytes: a folder has none and an Eigen container is a directory of dbs.
        downloadUrl:
            path.type === 'file' ? getDriveDownloadUrl(path.ownerId, path.mountId, path.id, updated) : undefined,
        thumbnailUrl: path.thumbnail
            ? getDriveThumbnailUrl(path.ownerId, path.mountId, path.thumbnail, updated)
            : undefined,
        drive: path,
    };
}
