import { randomUUID } from 'node:crypto';
import type { CryptoHasher, FileSink } from 'bun';
import { ApiError } from '../core';
import type { Mount } from '../mount';
import { MaxFileSizeExceededError, parseMultipartRequest } from '../multipart';

export type StreamResult = {
    tempId: string;
    hash: string;
    size: number;
    mimeType: string;
    fileName: string;
};

type InFlightFile = {
    tempId: string;
    writer: FileSink;
    hasher: CryptoHasher;
    fileName: string;
    mimeType: string;
};

export async function streamFilesToTemp(
    mount: Mount,
    request: Request,
    maxSizePerFile: number,
): Promise<StreamResult[]> {
    const results: StreamResult[] = [];
    let current: InFlightFile | null = null;

    try {
        for await (const event of parseMultipartRequest(request, { maxFileSize: maxSizePerFile })) {
            if (event.type === 'part') {
                if (!event.filename) continue; // non-file field: chunks fall through unconsumed
                const tempId = randomUUID();
                current = {
                    tempId,
                    writer: Bun.file(mount.getTempPath(tempId)).writer({ highWaterMark: 256 * 1024 }),
                    hasher: new Bun.CryptoHasher('sha256'),
                    fileName: event.filename,
                    mimeType: event.mediaType || 'application/octet-stream',
                };
            } else if (event.type === 'chunk') {
                if (current) {
                    current.hasher.update(event.data);
                    current.writer.write(event.data);
                }
            } else if (event.type === 'end' && current) {
                await current.writer.end();
                results.push({
                    tempId: current.tempId,
                    hash: current.hasher.digest('hex'),
                    size: event.size,
                    mimeType: current.mimeType,
                    fileName: current.fileName,
                });
                current = null;
            }
        }
    } catch (e) {
        // Clean up the in-flight file and any temp files from already-parsed parts
        if (current) {
            try {
                await current.writer.end();
            } catch {}
            await mount.cleanupTemp(current.tempId);
        }
        await Promise.all(results.map((r) => mount.cleanupTemp(r.tempId)));
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
