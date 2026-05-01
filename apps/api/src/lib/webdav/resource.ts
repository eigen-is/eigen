import { isContainerType } from '@workspace/lib/types/drive';
import { enforceMountQuota } from '../config/enforcement';
import { ApiError } from '../core/errors';
import { getSharedDrive } from '../drive/get-drive';
import type { User } from '../user';
import { enclosingDocumentContainer } from './container-guard';
import { assertWritable } from './locks';
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
    user: User;
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
    const path = await drive.resolvePath(mountId, pathStr);
    if (!path) throw new ApiError(404, 'Not found');
    if (path.type !== 'file') throw new ApiError(405, 'Not a file');

    const etag = computeEtag(path);

    // RFC 7232 §6 precondition order: If-Match before If-None-Match.
    if (ifMatch && !ifMatchesEtag(ifMatch, etag)) {
        return new Response(null, { status: 412 });
    }
    if (ifNoneMatch && ifMatchesEtag(ifNoneMatch, etag)) {
        return new Response(null, { status: 304, headers: { ETag: etag } });
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
    user: User;
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
    // macOS Finder (WebDAVFS/3.0.0) opens a copy by sending a 0-byte PUT to
    // reserve the resource, then follows up with the actual content. A null
    // body or Content-Length: 0 must succeed and create an empty file.
    const data: Buffer | ReadableStream<Uint8Array> = body ?? Buffer.alloc(0);

    const drive = await getSharedDrive(ownerId, user);
    const existing = await drive.resolvePath(mountId, pathStr);

    if (existing && isContainerType(existing.type)) {
        throw new ApiError(409, 'Cannot PUT over a collection');
    }

    const lastSlash = pathStr.lastIndexOf('/');
    const parentStr = pathStr.slice(0, lastSlash) || '/';
    const name = pathStr.slice(lastSlash + 1).normalize('NFC');
    if (!name) throw new ApiError(400, 'Missing file name');

    const parent = await drive.resolvePath(mountId, parentStr);
    if (!parent) throw new ApiError(409, 'Parent not found');

    // One breadcrumb fetch covers both checks. For an existing PUT, "is the
    // file inside a container?" — the file itself isn't, only its ancestors
    // matter (includeSelf=false). For a new PUT, "are writes INTO parent
    // blocked?" — parent itself counts (includeSelf=true). The lock check
    // (RFC 4918 §6.2 depth-infinity) uses the same breadcrumb either way.
    const breadcrumb = existing
        ? await drive.breadCrumb(mountId, existing.id)
        : await drive.breadCrumb(mountId, parent.id);
    if (enclosingDocumentContainer(breadcrumb, { includeSelf: !existing })) {
        throw new ApiError(423, 'Container internals are read-only');
    }
    assertWritable(drive.lockManager, breadcrumb, ifHeader, user.id);

    if (existing) {
        const etag = computeEtag(existing);
        if (ifMatch && !ifMatchesEtag(ifMatch, etag)) {
            return new Response(null, { status: 412 });
        }
        if (ifNoneMatch === '*') return new Response(null, { status: 412 });
    } else if (ifMatch === '*') {
        return new Response(null, { status: 412 });
    }

    // Pre-check Content-Length against quota — cheap reject for honest clients.
    // A client that lies (or omits Content-Length) can exceed quota by one PUT;
    // they're authenticated, so noisy-user not attack-vector.
    if (contentLength !== null) {
        await enforceMountQuota(ownerId, user.id, mountId, contentLength, existing?.size ?? 0);
    }

    const path = existing
        ? await drive.writeFileContent(mountId, existing.id, data)
        : await drive.createFileFromData(mountId, parent.id, name, mimeTypeFromName(name), data);

    return new Response(null, {
        status: existing ? 204 : 201,
        headers: { ETag: computeEtag(path), 'Last-Modified': path.updatedAt.toUTCString() },
    });
}

export async function handleMkcol(args: {
    user: User;
    ownerId: string;
    mountId: string;
    pathStr: string;
    contentLength: number;
    ifHeader: string | null;
}): Promise<Response> {
    const { user, ownerId, mountId, pathStr, contentLength, ifHeader } = args;
    if (contentLength > 0) {
        throw new ApiError(415, 'MKCOL request body not supported');
    }

    const drive = await getSharedDrive(ownerId, user);
    if (await drive.resolvePath(mountId, pathStr)) {
        // RFC 4918 §9.3.1: target exists → 405 Method Not Allowed
        return new Response(null, { status: 405 });
    }

    const lastSlash = pathStr.lastIndexOf('/');
    const parentStr = pathStr.slice(0, lastSlash) || '/';
    const name = pathStr.slice(lastSlash + 1).normalize('NFC');
    if (!name) throw new ApiError(400, 'Missing folder name');

    const parent = await drive.resolvePath(mountId, parentStr);
    if (!parent) throw new ApiError(409, 'Parent not found');

    const breadcrumb = await drive.breadCrumb(mountId, parent.id);
    if (enclosingDocumentContainer(breadcrumb, { includeSelf: true })) {
        throw new ApiError(423, 'Container internals are read-only');
    }
    assertWritable(drive.lockManager, breadcrumb, ifHeader, user.id);

    await drive.createFolder(mountId, parent.id, name);
    return new Response(null, { status: 201 });
}

export async function handleDelete(args: {
    user: User;
    ownerId: string;
    mountId: string;
    pathStr: string;
    ifHeader: string | null;
}): Promise<Response> {
    const { user, ownerId, mountId, pathStr, ifHeader } = args;
    const drive = await getSharedDrive(ownerId, user);
    const path = await drive.resolvePath(mountId, pathStr);
    if (!path) throw new ApiError(404, 'Not found');

    const breadcrumb = await drive.breadCrumb(mountId, path.id);
    if (enclosingDocumentContainer(breadcrumb, { includeSelf: false })) {
        throw new ApiError(423, 'Container internals are read-only');
    }
    assertWritable(drive.lockManager, breadcrumb, ifHeader, user.id);
    await drive.deletePath(mountId, path.id);
    drive.lockManager.releaseAllForPath(path.id);
    return new Response(null, { status: 204 });
}
