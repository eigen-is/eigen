import type { ProtocolUser } from '../auth/protocol-auth';
import { ApiError } from '../core/errors';
import { getWebdavDrive } from './get-drive';
import { WebdavPathCache } from './path-resolve';
import { computeEtag } from './xml';

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
