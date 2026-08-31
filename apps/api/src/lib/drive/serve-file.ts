import { DRIVE_TYPE_FILE } from '@workspace/lib/types';
import type { DrivePath } from '@workspace/lib/types/drive';
import { ApiError } from '../core';
import { computeEtag, contentDisposition, etagMatches, parseByteRange, scriptableInlineHeaders } from '../core/http';
import type { Mount } from '../mount';

// Header/range/CSP mechanics for serving a file body. Pure Mount function —
// the drive routes resolve mount + path (via SharedDrive ACL) and delegate here.
export async function serveFile(
    mount: Mount,
    path: DrivePath,
    disposition: 'attachment' | 'inline',
    range: string | null,
    ifNoneMatch: string | null = null,
): Promise<Response> {
    if (path.type !== DRIVE_TYPE_FILE) throw new ApiError(404, 'File not found');
    const mimeType = path.mimeType || 'application/octet-stream';
    const etag = computeEtag(path);
    const headers: Record<string, string> = {
        'Content-Type': mimeType,
        'Content-Disposition': contentDisposition(disposition, path.details?.originalName || path.name),
        // no-cache = revalidate on every use; the ETag makes that a cheap 304 round-trip.
        'Cache-Control': 'private, no-cache',
        ETag: etag,
        // Stored MIME is the upload's own Content-Type, served verbatim — nosniff stops the
        // browser re-sniffing a disguised payload (e.g. HTML bytes uploaded as image/png).
        'X-Content-Type-Options': 'nosniff',
        // Advertise range support so media players seek by fetching byte ranges instead of
        // re-downloading the whole file (notably from S3, where readRange issues a ranged GET).
        'Accept-Ranges': 'bytes',
    };
    // /embed serves inline from the API's own origin, so a scriptable upload gets a sandbox CSP
    // (scriptableInlineHeaders owns the scriptable-type set + CSP string; nosniff is already set above).
    if (disposition === 'inline') Object.assign(headers, scriptableInlineHeaders(mimeType));

    // RFC 7232 §6: a matching conditional GET returns 304 regardless of Range.
    if (ifNoneMatch && etagMatches(ifNoneMatch, etag)) {
        return new Response(null, { status: 304, headers });
    }

    const parsed = parseByteRange(range, path.size);
    if (parsed === 'unsatisfiable') {
        return new Response(null, {
            status: 416,
            headers: { ...headers, 'Content-Range': `bytes */${path.size}` },
        });
    }
    if (parsed) {
        const slice = await mount.readRange(path.id, parsed.start, parsed.end + 1);
        if (!slice) throw new ApiError(404, 'File not found');
        // Stream the slice. Passing the BunFile/S3File directly loses the slice bounds
        // somewhere in the response pipeline, so route through .stream() which respects them.
        return new Response(slice.stream(), {
            status: 206,
            headers: {
                ...headers,
                'Content-Length': String(parsed.end - parsed.start + 1),
                'Content-Range': `bytes ${parsed.start}-${parsed.end}/${path.size}`,
            },
        });
    }

    const file = await mount.readFile(path.id);
    if (!file) throw new ApiError(404, 'File not found');
    // S3File doesn't support ResponseInit options — stream it instead
    const body: BodyInit = 'bucket' in file ? file.stream() : file;
    return new Response(body, { headers });
}
