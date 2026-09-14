import { BROWSER_IMAGE_MIMES, getTextPreviewMode, isExiftoolExtension } from '../constants/preview';
import { type DrivePath, isVCardFile } from '../types/drive';
import type { FileSubject } from '../types/file-subject';
import { type Attachment, mailAttachmentName } from '../types/mail';
import {
    getDriveDownloadUrl,
    getDriveEmbedUrl,
    getDriveThumbnailUrl,
    getMailAttachmentEmbedUrl,
    getMailAttachmentUrl,
} from './api';

export function subjectFromPath(path: DrivePath): FileSubject {
    const updated = new Date(path.updatedAt);
    return {
        key: `drive:${path.ownerId}:${path.mountId}:${path.id}`,
        name: path.name,
        mimeType: path.mimeType,
        size: path.size,
        embedUrl: getDriveEmbedUrl(path.ownerId, path.mountId, path.id, path.name, updated),
        // Only a plain file has bytes to download; a container is a directory of dbs.
        downloadUrl:
            path.type === 'file' ? getDriveDownloadUrl(path.ownerId, path.mountId, path.id, updated) : undefined,
        thumbnailUrl: path.thumbnail
            ? getDriveThumbnailUrl(path.ownerId, path.mountId, path.thumbnail, updated)
            : undefined,
        drive: path,
    };
}

// `index` is the raw part index the mail routes address, calendar parts included.
export function subjectFromMailAttachment(
    ownerId: string,
    messageId: string,
    index: number,
    att: Pick<Attachment, 'contentType' | 'filename' | 'size'>,
): FileSubject {
    const name = mailAttachmentName(att, index);
    return {
        key: `mail:${ownerId}:${messageId}:${index}`,
        name,
        mimeType: att.contentType,
        size: att.size,
        embedUrl: getMailAttachmentEmbedUrl(ownerId, messageId, index, name),
        downloadUrl: getMailAttachmentUrl(ownerId, messageId, index, name),
        mail: { ownerId, messageId, index },
    };
}

export type PreviewMode = 'image' | 'video' | 'audio' | 'pdf' | 'text' | 'vcard' | 'fallback';

// A Drive image is resized by /preview; any other <img> shows the original bytes, so only a browser-decodable
// mime is an image. Text and vCard previews are served for Drive files and mail parts alike (PREVIEWS.md).
export function getPreviewMode(subject: FileSubject): PreviewMode {
    const mime = subject.mimeType;
    const isImage = subject.drive
        ? mime.startsWith('image/') || isExiftoolExtension(subject.name)
        : BROWSER_IMAGE_MIMES.has(mime);
    if (isImage) return 'image';
    if (mime.startsWith('video/')) return 'video';
    if (mime.startsWith('audio/')) return 'audio';
    if (mime === 'application/pdf') return 'pdf';
    if (isVCardFile(mime, subject.name)) return 'vcard';
    if (getTextPreviewMode(mime, subject.name) !== null) return 'text';
    return 'fallback';
}
