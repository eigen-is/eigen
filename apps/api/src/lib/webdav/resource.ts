import { isContainerType } from '@workspace/lib/types/drive';
import { enforceMountQuota } from '../config/enforcement';
import { ApiError } from '../core/errors';
import { computeEtag, etagMatches, rangeResponse, scriptableInlineHeaders } from '../core/http';
import { getSharedDrive } from '../drive/get-drive';
import type { User } from '../user';
import { enclosingDocumentContainer } from './container-guard';
import { assertWritable } from './locks';
import { splitParentAndName } from './path';

// If-Match only — RFC 7232 requires STRONG comparison here (no W/ strip); If-None-Match
// uses the shared weak matcher etagMatches.
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
    if (ifNoneMatch && etagMatches(ifNoneMatch, etag)) {
        return new Response(null, { status: 304, headers: { ETag: etag } });
    }

    const headers: Record<string, string> = {
        'Content-Type': path.mimeType,
        'Content-Length': String(path.size),
        ETag: etag,
        'Last-Modified': path.updatedAt.toUTCString(),
        'Accept-Ranges': 'bytes',
        // Same hardening REST serveFile applies: nosniff on every body, plus a sandbox CSP for
        // scriptable types (html/xhtml/svg) so a disguised upload can't run script with the
        // viewer's session. Harmless to real WebDAV clients, which ignore CSP on a download.
        'X-Content-Type-Options': 'nosniff',
        ...scriptableInlineHeaders(path.mimeType),
    };

    if (headOnly) return new Response(null, { status: 200, headers });

    return rangeResponse(headers, path.size, rangeHeader, {
        slice: async (start, end) => {
            const slice = await drive.readRange(mountId, path.id, start, end);
            if (!slice) throw new ApiError(404, 'Not found');
            // Stream the slice. Passing the BunFile/S3File directly loses the slice bounds
            // somewhere in the response pipeline, so route through .stream() which respects them.
            return slice.stream();
        },
        full: async () => {
            const file = await drive.downloadFile(mountId, path.id);
            if (!file) throw new ApiError(404, 'Not found');
            // S3File can't be used as a Response body directly — stream it. BunFile works either way.
            return 'bucket' in file ? file.stream() : file;
        },
    });
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

    const { parentStr, name } = splitParentAndName(pathStr);
    if (!name) throw new ApiError(400, 'Missing file name');

    const parent = await drive.resolvePath(mountId, parentStr);
    if (!parent) throw new ApiError(409, 'Parent not found');

    // One breadcrumb, for the guard and the RFC 4918 §6.2 lock check: parent counts on create, ancestors on overwrite.
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

    const mimeType = Bun.file(name).type || 'application/octet-stream';
    const path = existing
        ? await drive.writeFileContent(mountId, existing.id, data, user)
        : await drive.createFileFromData(mountId, parent.id, name, mimeType, data, user);

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

    const { parentStr, name } = splitParentAndName(pathStr);
    if (!name) throw new ApiError(400, 'Missing folder name');

    const parent = await drive.resolvePath(mountId, parentStr);
    if (!parent) throw new ApiError(409, 'Parent not found');

    const breadcrumb = await drive.breadCrumb(mountId, parent.id);
    if (enclosingDocumentContainer(breadcrumb, { includeSelf: true })) {
        throw new ApiError(423, 'Container internals are read-only');
    }
    assertWritable(drive.lockManager, breadcrumb, ifHeader, user.id);

    await drive.createFolder(mountId, parent.id, name, user);
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
    await drive.deletePath(mountId, path.id, user);
    drive.lockManager.releaseAllForPath(path.id);
    return new Response(null, { status: 204 });
}
