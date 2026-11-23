// Sends files into a Drive folder as one multipart POST, the one upload every caller shares, such as an editor's
// pasted image or Drive's Upload files. It goes by XHR, because fetch reports no upload progress. It resolves with
// the paths the server made and rejects with an AppError carrying the server's reason, or with the signal's reason
// when the caller cancels. The upload hooks call it.

import { getDriveFileUploadUrl } from '@workspace/lib/api';
import type { DrivePath } from '@workspace/lib/types/drive';
import { AppError } from '../api-error';
import { reviveTimestamp } from '../revive-timestamp';

export type UploadOptions = { onProgress?: (percent: number) => void; signal?: AbortSignal };

export function uploadFiles(
    ownerId: string,
    mountId: string,
    parentId: string,
    files: readonly File[],
    { onProgress, signal }: UploadOptions = {},
): Promise<DrivePath[]> {
    const formData = new FormData();
    for (const file of files) formData.append('file', file);
    return new Promise((resolve, reject) => {
        signal?.throwIfAborted();
        const xhr = new XMLHttpRequest();
        xhr.open('POST', getDriveFileUploadUrl(ownerId, mountId, parentId));
        xhr.withCredentials = true;
        xhr.upload.onprogress = (event) => {
            if (event.lengthComputable) onProgress?.(Math.round((event.loaded / event.total) * 100));
        };
        xhr.onload = () => {
            if (xhr.status < 200 || xhr.status >= 300) {
                // An ApiError answers plain text and a rejected schema answers JSON, and AppError reads either.
                const isJson = xhr.getResponseHeader('content-type')?.includes('application/json');
                const value: unknown = isJson ? JSON.parse(xhr.responseText) : xhr.responseText;
                reject(new AppError({ status: xhr.status, error: { status: xhr.status, value } }));
                return;
            }
            const paths: DrivePath[] = JSON.parse(xhr.responseText, reviveTimestamp);
            resolve(paths);
        };
        xhr.onerror = () => reject(new Error('Upload failed: the server could not be reached'));
        xhr.onabort = () => reject(signal?.reason);
        signal?.addEventListener('abort', () => xhr.abort(), { once: true });
        xhr.send(formData);
    });
}
