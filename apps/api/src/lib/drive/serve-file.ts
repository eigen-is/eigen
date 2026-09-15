import { DRIVE_TYPE_FILE } from '@workspace/lib/types';
import type { DrivePath } from '@workspace/lib/types/drive';
import { ApiError } from '../core';
import {
    computeEtag,
    contentDisposition,
    matchesIfNoneMatch,
    rangeResponse,
    scriptableInlineHeaders,
} from '../core/http';
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
    if (ifNoneMatch && matchesIfNoneMatch(ifNoneMatch, etag)) {
        return new Response(null, { status: 304, headers });
    }

    return rangeResponse(headers, path.size, range, {
        slice: async (start, end) => {
            const slice = await mount.readRange(path.id, start, end);
            if (!slice) throw new ApiError(404, 'File not found');
            // Stream the slice. Passing the BunFile/S3File directly loses the slice bounds
            // somewhere in the response pipeline, so route through .stream() which respects them.
            return slice.stream();
        },
        full: async () => {
            const file = await mount.readFile(path.id);
            if (!file) throw new ApiError(404, 'File not found');
            // S3File doesn't support ResponseInit options — stream it instead
            return 'bucket' in file ? file.stream() : file;
        },
    });
}
