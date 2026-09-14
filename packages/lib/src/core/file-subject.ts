import { BROWSER_IMAGE_MIMES, getTextPreviewMode, isExiftoolExtension } from '../constants/preview';
import { type DrivePath, isVCardFile } from '../types/drive';
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

export type PreviewMode = 'image' | 'video' | 'audio' | 'pdf' | 'text' | 'vcard' | 'fallback';

// How the preview overlay renders a file. Every server-rendered mode needs a mount to query, so it
// gates on `drive`. Without one the <img> shows the original bytes instead of a resized WebP, which
// only a browser-decodable mime survives.
export function getPreviewMode(subject: FileSubject): PreviewMode {
    const mime = subject.mimeType || '';
    const isImage = subject.drive
        ? mime.startsWith('image/') || isExiftoolExtension(subject.name)
        : BROWSER_IMAGE_MIMES.has(mime);

    if (isImage) return 'image';
    if (mime.startsWith('video/')) return 'video';
    if (mime.startsWith('audio/')) return 'audio';
    if (mime === 'application/pdf') return 'pdf';
    // A .vcf reads as contact cards, never as its raw text — which is why getTextPreviewMode declines it.
    if (subject.drive && isVCardFile(mime, subject.name)) return 'vcard';
    if (subject.drive && getTextPreviewMode(mime, subject.name) !== null) return 'text';
    return 'fallback';
}
