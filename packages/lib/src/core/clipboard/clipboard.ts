import type { EigenClipboardData } from '../../types/clipboard';
import type { DrivePath } from '../../types/drive';
import { getDriveDownloadUrl } from '../api';

export const EIGEN_CLIPBOARD_MIME = 'application/eigen-clipboard';
const HTML_MARKER = 'data-eigen-clipboard';

function parseEigenJson(raw: string): EigenClipboardData | null {
    try {
        const data = JSON.parse(raw) as EigenClipboardData;
        if (data.version === 1 && Array.isArray(data.items)) return data;
    } catch {
        /* invalid data */
    }
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
            } catch {
                /* invalid encoding */
            }
        }
    }
    return null;
}

export function writeEigenClipboard(e: ClipboardEvent, data: EigenClipboardData, plainText?: string, html?: string) {
    e.clipboardData?.setData(EIGEN_CLIPBOARD_MIME, JSON.stringify(data));
    const encoded = encodeURIComponent(JSON.stringify(data));
    const marker = `<span data-eigen-clipboard="${encoded}"></span>`;
    e.clipboardData?.setData('text/html', html ? marker + html : marker);
    if (plainText) {
        e.clipboardData?.setData('text/plain', plainText);
    }
}

export async function writeEigenClipboardAsync(data: EigenClipboardData, plainText?: string) {
    const json = JSON.stringify(data);
    const encoded = encodeURIComponent(json);
    const html = `<span ${HTML_MARKER}="${encoded}"></span>`;
    const items: Record<string, Blob> = {
        'text/html': new Blob([html], { type: 'text/html' }),
    };
    if (plainText) {
        items['text/plain'] = new Blob([plainText], { type: 'text/plain' });
    }
    await navigator.clipboard.write([new ClipboardItem(items)]);
}

export function needsReUpload(sourceParentId: string | null | undefined, targetMediaFolderId: string | null): boolean {
    if (!sourceParentId || !targetMediaFolderId) return false;
    return sourceParentId !== targetMediaFolderId;
}

export async function reUploadImage(
    sourcePathId: string,
    sourceOwnerId: string,
    sourceMountId: string,
    mediaFolderId: string,
    uploadFn: (args: { parentId: string; file: File }) => Promise<DrivePath | null>,
    _targetOwnerId: string,
    _targetMountId: string,
    fileName: string,
): Promise<{ mediaName: string; pathId: string; parentId: string } | null> {
    try {
        const downloadUrl = getDriveDownloadUrl(sourceOwnerId, sourceMountId, sourcePathId);
        const response = await fetch(downloadUrl, { credentials: 'include' });
        if (!response.ok) return null;
        const blob = await response.blob();
        const file = new File([blob], fileName, { type: blob.type || 'image/png' });
        const result = await uploadFn({ parentId: mediaFolderId, file });
        if (result) {
            return {
                mediaName: result.name,
                pathId: result.id,
                parentId: mediaFolderId,
            };
        }
    } catch (e) {
        console.error('Re-upload failed:', e);
    }
    return null;
}
