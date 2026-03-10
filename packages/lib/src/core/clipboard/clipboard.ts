import type {DrivePath} from '../../types/drive';
import type {EigenClipboardData} from '../../types/clipboard';
import {getDriveDownloadUrl, getDriveEmbedUrl} from '../api';

export const EIGEN_CLIPBOARD_MIME = 'application/eigen-clipboard';
const HTML_MARKER = 'data-eigen-clipboard';

function parseEigenJson(raw: string): EigenClipboardData | null {
    try {
        const data = JSON.parse(raw) as EigenClipboardData;
        if (data.version === 1 && Array.isArray(data.items)) return data;
    } catch { /* invalid data */ }
    return null;
}

export function readEigenClipboard(clipboardData: DataTransfer): EigenClipboardData | null {
    const raw = clipboardData.getData(EIGEN_CLIPBOARD_MIME);
    if (raw) return parseEigenJson(raw);

    const html = clipboardData.getData('text/html');
    if (html) {
        const match = html.match(new RegExp(`${HTML_MARKER}="([^"]*?)"`));
        if (match?.[1]) {
            try {
                return parseEigenJson(decodeURIComponent(match[1]));
            } catch { /* invalid encoding */ }
        }
    }
    return null;
}

export function writeEigenClipboard(e: ClipboardEvent, data: EigenClipboardData, plainText?: string) {
    e.clipboardData?.setData(EIGEN_CLIPBOARD_MIME, JSON.stringify(data));
    if (plainText) {
        e.clipboardData?.setData('text/plain', plainText);
    }
}

export async function writeEigenClipboardAsync(data: EigenClipboardData, plainText?: string) {
    const json = JSON.stringify(data);
    const encoded = encodeURIComponent(json);
    const html = `<span ${HTML_MARKER}="${encoded}"></span>`;
    const items: Record<string, Blob> = {
        'text/html': new Blob([html], {type: 'text/html'}),
    };
    if (plainText) {
        items['text/plain'] = new Blob([plainText], {type: 'text/plain'});
    }
    await navigator.clipboard.write([new ClipboardItem(items)]);
}

export function needsReUpload(sourcePath: DrivePath | undefined, targetMediaFolderId: string | null): boolean {
    if (!sourcePath || !targetMediaFolderId) return false;
    return sourcePath.parentId !== targetMediaFolderId;
}

export async function reUploadImage(
    srcUrl: string,
    mediaFolderId: string,
    uploadFn: (args: {parentId: string; file: File}) => Promise<DrivePath | null>,
    ownerId: string,
    mountId: string,
    sourcePath?: DrivePath,
): Promise<{src: string; sourcePath: DrivePath} | null> {
    try {
        const downloadUrl = sourcePath
            ? getDriveDownloadUrl(sourcePath.ownerId, sourcePath.mountId, sourcePath.id)
            : srcUrl;
        const response = await fetch(downloadUrl, {credentials: 'include'});
        if (!response.ok) return null;
        const blob = await response.blob();
        const fileName = sourcePath?.name || 'image';
        const file = new File([blob], fileName, {type: blob.type || 'image/png'});
        const result = await uploadFn({parentId: mediaFolderId, file});
        if (result) {
            return {
                src: getDriveEmbedUrl(ownerId, mountId, result.id, 'image'),
                sourcePath: result,
            };
        }
    } catch (e) {
        console.error('Re-upload failed:', e);
    }
    return null;
}

