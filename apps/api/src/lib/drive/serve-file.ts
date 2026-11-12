// Answers a request for the bytes of one Drive file: the headers, a conditional 304, a byte range or the
// whole body. A route, such as a download, calls serveFile once SharedDrive has checked access. It also
// owns the name a file leaves Drive under, such as an attachment's when mail takes a file from Drive.

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
import { isInsideDocument } from './acl';

export async function serveFile(
    mount: Mount,
    path: DrivePath,
    disposition: 'attachment' | 'inline',
    range: string | null,
    ifNoneMatch: string | null,
): Promise<Response> {
    if (path.type !== DRIVE_TYPE_FILE) throw new ApiError(404, 'File not found');
    const etag = computeEtag(path);
    const headers: Record<string, string> = {
        'Content-Type': path.mimeType,
        'Content-Disposition': contentDisposition(disposition, await downloadName(mount, path)),
        // The client asks again on every use, and the ETag makes that a cheap 304.
        'Cache-Control': 'private, no-cache',
        ETag: etag,
        // The stored type is the upload's own claim, so the browser must not sniff a disguised payload into HTML.
        'X-Content-Type-Options': 'nosniff',
        // A media player seeks by byte range instead of downloading the whole file again.
        'Accept-Ranges': 'bytes',
    };
    // An inline body comes from the API's own origin, so a scriptable upload gets a sandbox CSP.
    if (disposition === 'inline') Object.assign(headers, scriptableInlineHeaders(path.mimeType));

    // RFC 7232 §6: a matching conditional GET returns 304 regardless of Range.
    if (ifNoneMatch && matchesIfNoneMatch(ifNoneMatch, etag)) {
        return new Response(null, { status: 304, headers });
    }

    return rangeResponse(headers, path.size, range, {
        slice: async (start, end) => {
            const slice = await mount.readRange(path.id, start, end);
            if (!slice) throw new ApiError(404, 'File not found');
            // A BunFile or S3File passed as it is loses the slice bounds on its way out, and its stream keeps them.
            return slice.stream();
        },
        full: async () => {
            const file = await mount.readFile(path.id);
            if (!file) throw new ApiError(404, 'File not found');
            // An S3File can't be a Response body as it is, so it goes in as a stream. A BunFile works either way.
            return 'bucket' in file ? file.stream() : file;
        },
    });
}

// A file goes by the name Drive shows. Inside a document nobody sees or renames the stored name, which an
// upload may have numbered, so an attachment there keeps the name it was uploaded with.
export async function downloadName(mount: Mount, path: DrivePath): Promise<string> {
    const uploadedAs = path.details?.originalName;
    if (!uploadedAs || uploadedAs === path.name) return path.name;
    return isInsideDocument(await mount.getBreadcrumb(path.id)) ? uploadedAs : path.name;
}
