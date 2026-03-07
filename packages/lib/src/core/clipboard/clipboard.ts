import type {DrivePath} from '../../types/drive';
import type {EigenClipboardData} from '../../types/clipboard';
import {getDriveEmbedUrl} from '../api';

export const EIGEN_CLIPBOARD_MIME = 'application/eigen-clipboard';

export function readEigenClipboard(clipboardData: DataTransfer): EigenClipboardData | null {
    const raw = clipboardData.getData(EIGEN_CLIPBOARD_MIME);
    if (!raw) return null;
    try {
        const data = JSON.parse(raw) as EigenClipboardData;
        if (data.version === 1 && Array.isArray(data.items)) return data;
    } catch { /* invalid data */ }
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
    const blob = new Blob([json], {type: EIGEN_CLIPBOARD_MIME});
    const items: Record<string, Blob> = {[EIGEN_CLIPBOARD_MIME]: blob};
    if (plainText) {
        items['text/plain'] = new Blob([plainText], {type: 'text/plain'});
    }
    try {
        await navigator.clipboard.write([new ClipboardItem(items)]);
    } catch {
        if (plainText) await navigator.clipboard.writeText(plainText);
    }
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
): Promise<{src: string; sourcePath: DrivePath} | null> {
    try {
        const response = await fetch(srcUrl, {credentials: 'include'});
        if (!response.ok) return null;
        const blob = await response.blob();
        const file = new File([blob], 'image', {type: blob.type || 'image/png'});
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

