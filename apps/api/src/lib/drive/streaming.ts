import { randomUUID } from 'node:crypto';
import { MaxFileSizeExceededError, parseMultipartRequest } from '@mjackson/multipart-parser';
import { ApiError } from '../core';
import type { Mount } from '../mount';

export type StreamResult = {
    tempId: string;
    hash: string;
    size: number;
    mimeType: string;
    fileName: string;
};

export async function streamFilesToTemp(
    mount: Mount,
    request: Request,
    maxSizePerFile: number,
): Promise<StreamResult[]> {
    const results: StreamResult[] = [];

    try {
        for await (const part of parseMultipartRequest(request, { maxFileSize: maxSizePerFile })) {
            if (!part.isFile || !part.filename) continue;

            const tempId = randomUUID();
            const tempPath = mount.getTempPath(tempId);
            const writer = Bun.file(tempPath).writer({ highWaterMark: 256 * 1024 });
            const hasher = new Bun.CryptoHasher('sha256');

            try {
                for (const chunk of part.content) {
                    hasher.update(chunk);
                    writer.write(chunk);
                }
                await writer.end();
            } catch (e) {
                await writer.end();
                await mount.cleanupTemp(tempId);
                throw e;
            }

            results.push({
                tempId,
                hash: hasher.digest('hex'),
                size: part.size,
                mimeType: part.mediaType || 'application/octet-stream',
                fileName: part.filename,
            });
        }
    } catch (e) {
        // Clean up any temp files from already-parsed parts
        for (const r of results) await mount.cleanupTemp(r.tempId);
        if (e instanceof MaxFileSizeExceededError) {
            throw new ApiError(413, 'File exceeds maximum upload size');
        }
        throw e;
    }

    if (results.length === 0) {
        throw new ApiError(400, 'No file found in request');
    }

    return results;
}
