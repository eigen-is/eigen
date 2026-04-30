import { isContainerType } from '@workspace/lib/types/drive';
import type { ProtocolUser } from '../auth/protocol-auth';
import { ApiError } from '../core/errors';
import { getSharedDrive } from '../drive/get-drive';
import { assertWritable } from './locks';
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
    const drive = await getSharedDrive(ownerId, user);
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
    ifHeader: string | null;
}): Promise<Response> {
    const { user, ownerId, mountId, pathStr, body, contentLength, ifMatch, ifNoneMatch, ifHeader } = args;
    if (!body) throw new ApiError(400, 'No body');

    const drive = await getSharedDrive(ownerId, user);
    const cache = new WebdavPathCache();
    const existing = await cache.resolve(drive, mountId, pathStr);

    if (existing && isContainerType(existing.type)) {
        throw new ApiError(409, 'Cannot PUT over a collection');
    }
    if (existing && (await drive.isInsideContainer(mountId, existing.id))) {
        throw new ApiError(423, 'Container internals are read-only');
    }

    if (existing) {
        await assertWritable(drive, mountId, existing.id, ifHeader, user.id);
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
    if (await drive.isContainerWriteBlocked(mountId, parent.id)) {
        throw new ApiError(423, 'Container internals are read-only');
    }
    // Depth-infinity lock on the parent (or any of its ancestors) must block PUT
    // of new children. assertWritable walks the breadcrumb to honor that.
    if (!existing) {
        await assertWritable(drive, mountId, parent.id, ifHeader, user.id);
    }

    // Pre-check Content-Length against quota — cheap reject for honest clients.
    // A client that lies (or omits Content-Length) can exceed quota by one PUT;
    // they're authenticated, so noisy-user not attack-vector.
    if (contentLength !== null) {
        const [used, total] = await Promise.all([drive.usedBytes(mountId), drive.quotaBytes(mountId)]);
        const projected = used + contentLength - (existing?.size ?? 0);
        if (projected > total) throw new ApiError(507, 'Insufficient Storage');
    }

    const path = existing
        ? await drive.writeFileContent(mountId, existing.id, body)
        : await drive.createFileFromData(mountId, parent.id, name, mimeTypeFromName(name), body);

    return new Response(null, {
        status: existing ? 204 : 201,
        headers: { ETag: computeEtag(path), 'Last-Modified': path.updatedAt.toUTCString() },
    });
}

export async function handleMkcol(args: {
    user: ProtocolUser;
    ownerId: string;
    mountId: string;
    pathStr: string;
    contentLength: number;
    ifHeader: string | null;
}): Promise<Response> {
    const { user, ownerId, mountId, contentLength, ifHeader } = args;
    if (contentLength > 0) {
        throw new ApiError(415, 'MKCOL request body not supported');
    }

    // Strip trailing slash so /foo/ creates /foo. Root → '/' which resolves to existing → 405.
    const pathStr = args.pathStr.replace(/\/+$/, '') || '/';

    const drive = await getSharedDrive(ownerId, user);
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
    if (await drive.isContainerWriteBlocked(mountId, parent.id)) {
        throw new ApiError(423, 'Container internals are read-only');
    }
    await assertWritable(drive, mountId, parent.id, ifHeader, user.id);

    await drive.createFolder(mountId, parent.id, name);
    return new Response(null, { status: 201 });
}

export async function handleDelete(args: {
    user: ProtocolUser;
    ownerId: string;
    mountId: string;
    pathStr: string;
    ifHeader: string | null;
}): Promise<Response> {
    const { user, ownerId, mountId, ifHeader } = args;
    // Normalise trailing slash so /foo/ and /foo share a cache key.
    const pathStr = args.pathStr.replace(/\/+$/, '') || '/';

    const drive = await getSharedDrive(ownerId, user);
    const cache = new WebdavPathCache();
    const path = await cache.resolve(drive, mountId, pathStr);
    if (!path) throw new ApiError(404, 'Not found');
    if (await drive.isInsideContainer(mountId, path.id)) {
        throw new ApiError(423, 'Container internals are read-only');
    }
    await assertWritable(drive, mountId, path.id, ifHeader, user.id);
    await drive.deletePath(mountId, path.id);
    return new Response(null, { status: 204 });
}
