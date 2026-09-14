import { type Attachment, mailAttachmentName } from '@workspace/lib/types/mail';
import { contentDisposition, etagMatches, parseByteRange, scriptableInlineHeaders } from '../core/http';

const MAIL_PART_CACHE_CONTROL = 'private, max-age=86400';

// A Maildir body is immutable once delivered, so message id + part index pins the bytes for good.
export function mailPartEtag(messageId: string, index: number): string {
    return `"${messageId}-${index}"`;
}

// Routes answer this BEFORE messageGetAttachment: getAttachments re-parses and decodes the whole
// .eml per request, which a seeking media player would otherwise pay on every range.
export function mailPartNotModified(etag: string, ifNoneMatch: string | null): Response | null {
    if (!ifNoneMatch || !etagMatches(ifNoneMatch, etag)) return null;
    return new Response(null, { status: 304, headers: { ETag: etag, 'Cache-Control': MAIL_PART_CACHE_CONTROL } });
}

// Header/range mechanics for serving one parsed mail part, shared by the download and embed routes.
// The part is already in memory, so a range is two lines — mail video/audio parts reach a media
// element whose seeking needs them, and Safari refuses a source that advertises none.
export function serveMailPart(
    att: Attachment,
    index: number,
    disposition: 'attachment' | 'inline',
    range: string | null,
    etag: string,
): Response {
    const headers: Record<string, string> = {
        'Content-Type': att.contentType,
        'Content-Disposition': contentDisposition(disposition, mailAttachmentName(att, index)),
        'Cache-Control': MAIL_PART_CACHE_CONTROL,
        ETag: etag,
        // The sender's declared type, served verbatim — nosniff stops the browser re-sniffing a
        // disguised payload (e.g. HTML bytes sent as image/png).
        'X-Content-Type-Options': 'nosniff',
        'Accept-Ranges': 'bytes',
    };
    // /embed serves inline from the API's own origin, so a scriptable part gets a sandbox CSP.
    if (disposition === 'inline') Object.assign(headers, scriptableInlineHeaders(att.contentType));

    const size = att.content.byteLength;
    const parsed = parseByteRange(range, size);
    if (parsed === 'unsatisfiable') {
        return new Response(null, { status: 416, headers: { ...headers, 'Content-Range': `bytes */${size}` } });
    }
    // .slice() over .subarray(): a Uint8Array backed by ArrayBufferLike, which is what the MIME
    // decoders hand back, is not a BodyInit. The copy costs far less than the parse above it.
    if (parsed) {
        return new Response(att.content.slice(parsed.start, parsed.end + 1), {
            status: 206,
            headers: {
                ...headers,
                'Content-Length': String(parsed.end - parsed.start + 1),
                'Content-Range': `bytes ${parsed.start}-${parsed.end}/${size}`,
            },
        });
    }
    return new Response(att.content.slice(), { headers: { ...headers, 'Content-Length': String(size) } });
}
