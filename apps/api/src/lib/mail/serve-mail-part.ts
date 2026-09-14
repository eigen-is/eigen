import { type Attachment, mailAttachmentName } from '@workspace/lib/types/mail';
import { ApiError, contentDisposition, etagMatches, rangeResponse, scriptableInlineHeaders } from '../core';
import type { Mail } from './mail-domain';

// The part every mail route serves, or null on a 304 answered off the summary row, before the .eml is parsed.
// no-cache: the URL has no version stamp, and a draft save rewrites the message under its id (date + size move).
export async function readMailPart(
    mail: Mail,
    messageId: string,
    index: number,
    request: Request,
    set: { headers: Record<string, string | number> },
): Promise<Attachment | null> {
    const summary = mail.messageGetSummary(messageId);
    if (!summary) throw new ApiError(404, `Message '${messageId}' not found`);

    const etag = `"${summary.id}-${index}-${summary.date.getTime()}-${summary.size}"`;
    const ifNoneMatch = request.headers.get('if-none-match');
    const att =
        ifNoneMatch && etagMatches(ifNoneMatch, etag) ? null : await mail.messageGetAttachment(messageId, index);
    set.headers['Cache-Control'] = 'private, no-cache';
    set.headers['ETag'] = etag;
    return att;
}

// One response shape for the download and the embed route: the part's own type and name, ranges because
// a mail video/audio part reaches a media element that seeks (Safari refuses a source without them).
export function serveMailPart(
    att: Attachment,
    index: number,
    disposition: 'attachment' | 'inline',
    range: string | null,
): Promise<Response> {
    // A part with no Content-Type header parses to '', which no client can act on.
    const contentType = att.contentType || 'application/octet-stream';
    // A text part keeps the charset it declared: served bare, a latin-1 body is read as UTF-8 and shows
    // mojibake. The parser kept only a token, so nothing sender-written can break the header.
    const servedType =
        att.charset && contentType.startsWith('text/') ? `${contentType}; charset=${att.charset}` : contentType;
    const headers: Record<string, string> = {
        'Content-Type': servedType,
        'Content-Disposition': contentDisposition(disposition, mailAttachmentName(att, index)),
        'X-Content-Type-Options': 'nosniff',
        'Accept-Ranges': 'bytes',
        // Inline from the API's own origin, so a scriptable part gets the sandbox CSP.
        ...(disposition === 'inline' && scriptableInlineHeaders(contentType)),
    };

    const size = att.content.byteLength;
    // .slice(), not .subarray(): the decoders hand back a Uint8Array over ArrayBufferLike, which is no BodyInit.
    return rangeResponse(headers, size, range, {
        slice: (start, end) => att.content.slice(start, end),
        full: () => att.content.slice(),
    });
}
