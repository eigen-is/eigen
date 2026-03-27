import {randomUUID} from 'crypto';
import {MaxFileSizeExceededError, parseMultipartRequest} from '@mjackson/multipart-parser';
import type {Mount} from '../mount';
import {ApiError} from '../core';

export type StreamResult = {
    tempId: string;
    hash: string;
    size: number;
    mimeType: string;
    fileName: string;
};

export async function streamToTemp(
    mount: Mount,
    request: Request,
    maxSize: number
): Promise<StreamResult> {
    const tempId = randomUUID();
    const tempPath = mount.getTempPath(tempId);
    const writer = Bun.file(tempPath).writer({highWaterMark: 256 * 1024});
    const hasher = new Bun.CryptoHasher('sha256');
    let size = 0;
    let mimeType = 'application/octet-stream';
    let fileName = 'unnamed';

    try {
        for await (const part of parseMultipartRequest(request, {maxFileSize: maxSize})) {
            if (!part.isFile || !part.filename) continue;

            fileName = part.filename;
            mimeType = part.mediaType || 'application/octet-stream';

            for (const chunk of part.content) {
                hasher.update(chunk);
                writer.write(chunk);
            }
            size = part.size;

            break; // single-file upload — only process first file part
        }

        await writer.end();
    } catch (e) {
        await writer.end();
        await mount.cleanupTemp(tempId);
        if (e instanceof MaxFileSizeExceededError) {
            throw new ApiError(413, 'File exceeds maximum upload size');
        }
        throw e;
    }

    if (size === 0) {
        await mount.cleanupTemp(tempId);
        throw new ApiError(400, 'No file found in request');
    }

    return {tempId, hash: hasher.digest('hex'), size, mimeType, fileName};
}
