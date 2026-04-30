import { randomUUID } from 'node:crypto';
import { isContainerType } from '@workspace/lib/types/drive';
import type { ProtocolUser } from '../auth/protocol-auth';
import { ApiError } from '../core/errors';
import { writeStreamToTemp } from '../drive/streaming';
import { getWebdavDrive } from './get-drive';
import { WebdavPathCache } from './path-resolve';
import { computeEtag } from './xml';

function mimeTypeFromName(name: string): string {
    return Bun.file(name).type || 'application/octet-stream';
}

function ifMatchesEtag(header: string, etag: string): boolean {
    if (header === '*') return true;
    return header
        .split(',')
        .map((s) => s.trim())
        .includes(etag);
}

export async function handleGet(args: {
    user: ProtocolUser;
    ownerId: string;
    mountId: string;
    pathStr: string;
    headOnly: boolean;
    rangeHeader: string | null;
    ifMatch: string | null;
    ifNoneMatch: string | null;
}): Promise<Response> {
    const { user, ownerId, mountId, pathStr, headOnly, rangeHeader, ifMatch, ifNoneMatch } = args;
    const drive = await getWebdavDrive(ownerId, user);
    const cache = new WebdavPathCache();
    const path = await cache.resolve(drive, mountId, pathStr);
    if (!path) throw new ApiError(404, 'Not found');
    if (path.type !== 'file') throw new ApiError(405, 'Not a file');

    const etag = computeEtag(path);

    if (ifNoneMatch && ifMatchesEtag(ifNoneMatch, etag)) {
        return new Response(null, { status: 304, headers: { ETag: etag } });
    }
    if (ifMatch && !ifMatchesEtag(ifMatch, etag)) {
        return new Response(null, { status: 412 });
    }

    const headers: Record<string, string> = {
        'Content-Type': path.mimeType,
        'Content-Length': String(path.size),
        ETag: etag,
        'Last-Modified': path.updatedAt.toUTCString(),
        'Accept-Ranges': 'bytes',
    };

    if (headOnly) return new Response(null, { status: 200, headers });

    if (rangeHeader) {
        if (path.size === 0) return new Response(null, { status: 416, headers });
        const match = rangeHeader.match(/^bytes=(\d*)-(\d*)$/);
        if (!match) return new Response(null, { status: 416, headers });
        const startStr = match[1];
        const endStr = match[2];
        // Suffix range "bytes=-N" means "last N bytes": start = size - N, end = size - 1.
        // Open-ended "bytes=N-" means "from N to EOF": end = size - 1.
        const start = startStr === '' ? Math.max(0, path.size - Number(endStr)) : Number(startStr);
        const end = endStr === '' || startStr === '' ? path.size - 1 : Math.min(Number(endStr), path.size - 1);
        if (start < 0 || start > end || start >= path.size) {
            return new Response(null, { status: 416, headers });
        }
        const slice = await drive.readRange(mountId, path.id, start, end + 1);
        if (!slice) throw new ApiError(404, 'Not found');
        // Stream the slice. Passing the BunFile/S3File directly loses the slice bounds
        // somewhere in the response pipeline, so route through .stream() which respects them.
        return new Response(slice.stream(), {
            status: 206,
            headers: {
                ...headers,
                'Content-Length': String(end - start + 1),
                'Content-Range': `bytes ${start}-${end}/${path.size}`,
            },
        });
    }

    const file = await drive.downloadFile(mountId, path.id);
    if (!file) throw new ApiError(404, 'Not found');
    // S3File can't be used as a Response body directly — stream it. BunFile works either way.
    const body: BodyInit = 'bucket' in file ? file.stream() : file;
    return new Response(body, { status: 200, headers });
}

export async function handlePut(args: {
    user: ProtocolUser;
    ownerId: string;
    mountId: string;
    pathStr: string;
    body: ReadableStream<Uint8Array> | null;
    contentLength: number | null;
    ifMatch: string | null;
    ifNoneMatch: string | null;
}): Promise<Response> {
    const { user, ownerId, mountId, pathStr, body, contentLength, ifMatch, ifNoneMatch } = args;
    if (!body) throw new ApiError(400, 'No body');

    const drive = await getWebdavDrive(ownerId, user);
    const cache = new WebdavPathCache();
    const existing = await cache.resolve(drive, mountId, pathStr);

    if (existing && isContainerType(existing.type)) {
        throw new ApiError(409, 'Cannot PUT over a collection');
    }
    if (existing && (await drive.isInsideContainer(mountId, existing.id))) {
        throw new ApiError(423, 'Container internals are read-only');
    }

    if (existing) {
        const etag = computeEtag(existing);
        if (ifMatch && !ifMatchesEtag(ifMatch, etag)) {
            return new Response(null, { status: 412 });
        }
        if (ifNoneMatch === '*') return new Response(null, { status: 412 });
    } else if (ifMatch === '*') {
        return new Response(null, { status: 412 });
    }

    const lastSlash = pathStr.lastIndexOf('/');
    const parentStr = pathStr.slice(0, lastSlash) || '/';
    const name = pathStr.slice(lastSlash + 1).normalize('NFC');
    if (!name) throw new ApiError(400, 'Missing file name');

    const parent = await cache.resolve(drive, mountId, parentStr);
    if (!parent) throw new ApiError(409, 'Parent not found');
    if (await drive.isInsideContainer(mountId, parent.id)) {
        throw new ApiError(423, 'Container internals are read-only');
    }

    // Two-stage quota enforcement. Stage 1: if the client advertised a Content-Length,
    // reject obviously oversized PUTs before we burn disk on the temp write. The client
    // might lie, so this is only a fast path; the real check happens after streaming.
    if (contentLength !== null) {
        const [used, total] = await Promise.all([drive.usedBytes(mountId), drive.quotaBytes(mountId)]);
        const projected = used + contentLength - (existing?.size ?? 0);
        if (projected > total) throw new ApiError(507, 'Insufficient Storage');
    }

    const tempId = randomUUID();
    const tempPath = drive.getTempPath(mountId, tempId);
    try {
        const tempInfo = await writeStreamToTemp(tempPath, body);

        // Stage 2: recheck against actual streamed size. Catches clients that lied about
        // Content-Length, or chunked uploads where Content-Length was absent.
        if (contentLength === null || tempInfo.size !== contentLength) {
            const [used, total] = await Promise.all([drive.usedBytes(mountId), drive.quotaBytes(mountId)]);
            const projected = used + tempInfo.size - (existing?.size ?? 0);
            if (projected > total) throw new ApiError(507, 'Insufficient Storage');
        }

        const path = existing
            ? await drive.overwriteFromTemp(mountId, existing.id, tempId)
            : await drive.createFromTemp(
                  mountId,
                  parent.id,
                  name,
                  mimeTypeFromName(name),
                  tempInfo.size,
                  tempInfo.hash,
                  tempId,
              );

        return new Response(null, {
            status: existing ? 204 : 201,
            headers: { ETag: computeEtag(path), 'Last-Modified': path.updatedAt.toUTCString() },
        });
    } finally {
        // createFileFromTemp/writeFile copy from temp without deleting it, so we always
        // run cleanup. cleanupTemp tolerates missing files (Task 6 — see Mount.cleanupTemp).
        await drive.cleanupTemp(mountId, tempId).catch(() => {});
    }
}

export async function handleMkcol(args: {
    user: ProtocolUser;
    ownerId: string;
    mountId: string;
    pathStr: string;
    contentLength: number;
}): Promise<Response> {
    const { user, ownerId, mountId, contentLength } = args;
    if (contentLength > 0) {
        throw new ApiError(415, 'MKCOL request body not supported');
    }

    // Strip trailing slash so /foo/ creates /foo. Root → '/' which resolves to existing → 405.
    const pathStr = args.pathStr.replace(/\/+$/, '') || '/';

    const drive = await getWebdavDrive(ownerId, user);
    const cache = new WebdavPathCache();
    if (await cache.resolve(drive, mountId, pathStr)) {
        // RFC 4918 §9.3.1: target exists → 405 Method Not Allowed
        return new Response(null, { status: 405 });
    }

    const lastSlash = pathStr.lastIndexOf('/');
    const parentStr = pathStr.slice(0, lastSlash) || '/';
    const name = pathStr.slice(lastSlash + 1).normalize('NFC');
    if (!name) throw new ApiError(400, 'Missing folder name');

    const parent = await cache.resolve(drive, mountId, parentStr);
    if (!parent) throw new ApiError(409, 'Parent not found');
    if (await drive.isInsideContainer(mountId, parent.id)) {
        throw new ApiError(423, 'Container internals are read-only');
    }

    await drive.createFolder(mountId, parent.id, name);
    return new Response(null, { status: 201 });
}

export async function handleDelete(args: {
    user: ProtocolUser;
    ownerId: string;
    mountId: string;
    pathStr: string;
}): Promise<Response> {
    const { user, ownerId, mountId } = args;
    // Normalise trailing slash so /foo/ and /foo share a cache key.
    const pathStr = args.pathStr.replace(/\/+$/, '') || '/';

    const drive = await getWebdavDrive(ownerId, user);
    const cache = new WebdavPathCache();
    const path = await cache.resolve(drive, mountId, pathStr);
    if (!path) throw new ApiError(404, 'Not found');
    if (await drive.isInsideContainer(mountId, path.id)) {
        throw new ApiError(423, 'Container internals are read-only');
    }
    await drive.deletePath(mountId, path.id);
    return new Response(null, { status: 204 });
}
