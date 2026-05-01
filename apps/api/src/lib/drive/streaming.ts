import { randomUUID } from 'node:crypto';
import { MaxFileSizeExceededError, parseMultipartRequest } from '@mjackson/multipart-parser';
import { ApiError } from '../core';
import type { Mount } from '../mount';
import type { StorageFile } from '../storage';

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

// Stream a buffer, StorageFile (BunFile/S3File), or ReadableStream into a temp path while
// computing the sha256 hash in a single pass. Avoids holding the full payload in memory twice.
export async function writeTempWithHash(
    tempPath: string,
    data: Buffer | Uint8Array | StorageFile | ReadableStream<Uint8Array>,
): Promise<{ size: number; hash: string }> {
    const hasher = new Bun.CryptoHasher('sha256');

    if (data instanceof Uint8Array) {
        await Bun.write(tempPath, data);
        hasher.update(data);
        return { size: data.byteLength, hash: hasher.digest('hex') };
    }

    const stream = data instanceof ReadableStream ? data : data.stream();
    const writer = Bun.file(tempPath).writer({ highWaterMark: 256 * 1024 });
    const reader = stream.getReader();
    let size = 0;
    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            hasher.update(value);
            writer.write(value);
            size += value.byteLength;
        }
        await writer.end();
    } catch (e) {
        await writer.end();
        throw e;
    }
    return { size, hash: hasher.digest('hex') };
}
