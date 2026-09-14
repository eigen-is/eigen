import {
    BROWSER_IMAGE_MIMES,
    getBytesTextPreviewMode,
    getTextPreviewMode,
    isExiftoolExtension,
    TEXT_PREVIEW_MAX_BYTES,
} from '../constants/preview';
import { type DrivePath, isCollabType, isVCardFile } from '../types/drive';
import type { FileSubject, MailPartRef, PreviewMode, SubjectInfo } from '../types/file-subject';
import { type Attachment, mailAttachmentName } from '../types/mail';
import {
    getDriveDownloadUrl,
    getDriveEmbedUrl,
    getDriveThumbnailUrl,
    getMailAttachmentEmbedUrl,
    getMailAttachmentUrl,
} from './api';

// `canWrite` is the holding surface's own capability: a listing the viewer may not write to marks its
// subjects read-only, so a row that writes beside the file (convert) doesn't apply.
export function subjectFromPath(path: DrivePath, capability?: { canWrite: boolean }): FileSubject {
    return { drive: path, ...(capability?.canWrite === false && { readOnly: true as const }) };
}

// `index` is the raw part index the mail routes address, calendar parts included.
export function subjectFromMailAttachment(
    ownerId: string,
    messageId: string,
    index: number,
    att: Pick<Attachment, 'contentType' | 'filename' | 'size'>,
): FileSubject {
    return { mail: { ownerId, messageId, index }, part: att, attachment: true };
}

// Everything that follows from a subject's identity, in the one place that knows the routes.
export function subjectInfo(subject: FileSubject): SubjectInfo {
    return subject.drive ? driveInfo(subject.drive) : mailInfo(subject.mail, subject.part);
}

function driveInfo(path: DrivePath): SubjectInfo {
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
    };
}

function mailInfo(
    { ownerId, messageId, index }: MailPartRef,
    part: Pick<Attachment, 'contentType' | 'filename' | 'size'>,
): SubjectInfo {
    const name = mailAttachmentName(part, index);
    return {
        key: `mail:${ownerId}:${messageId}:${index}`,
        name,
        mimeType: part.contentType,
        size: part.size,
        embedUrl: getMailAttachmentEmbedUrl(ownerId, messageId, index, name),
        downloadUrl: getMailAttachmentUrl(ownerId, messageId, index, name),
    };
}

// A Drive image is resized by /preview; any other <img> shows the original bytes, so only a browser-decodable
// mime is an image. Text and vCard previews are served for Drive files and mail parts alike (PREVIEWS.md).
export function getPreviewMode(subject: FileSubject): PreviewMode {
    const { name, mimeType: mime, size } = subjectInfo(subject);
    const isImage = subject.drive
        ? mime.startsWith('image/') || isExiftoolExtension(name)
        : BROWSER_IMAGE_MIMES.has(mime);
    if (isImage) return 'image';
    if (mime.startsWith('video/')) return 'video';
    if (mime.startsWith('audio/')) return 'audio';
    if (mime === 'application/pdf') return 'pdf';
    if (isVCardFile(mime, name)) return 'vcard';
    // The gate the preview routes run: a container renders from its Yjs body, everything else from its
    // bytes, and an eigen mime on loose bytes is only the uploader's or the sender's word.
    const container = subject.drive !== undefined && isCollabType(subject.drive.type);
    const textMode = container ? getTextPreviewMode(mime, name) : getBytesTextPreviewMode(mime, name);
    if (textMode === null) return 'fallback';
    // Past the ceiling the text routes serve nothing; a container's size is its databases, not its body.
    if (!container && size > TEXT_PREVIEW_MAX_BYTES) return 'fallback';
    return 'text';
}
