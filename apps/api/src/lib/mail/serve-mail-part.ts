import { type Attachment, mailAttachmentName } from '@workspace/lib/types/mail';
import type { ElysiaCustomStatusResponse } from 'elysia';
import { ApiError, answerRevalidated, contentDisposition, rangeResponse, scriptableInlineHeaders } from '../core';
import type { Mail } from './mail-domain';

// What a mail route answers for one part, or a 304 answered off the summary row before the .eml is parsed.
// no-cache: the URL has no version stamp, and a draft save rewrites the message under its id (date + size move).
// A preview route passes its renderer's format tag, so a payload or sanitizer fix is not answered with a 304
// on a message that has not changed; the two byte routes serve the part itself and have none.
export async function answerMailPart<T>(
    mail: Mail,
    messageId: string,
    index: number,
    request: Request,
    set: { headers: Record<string, string | number> },
    serve: (att: Attachment) => T | Promise<T>,
    format?: string,
): Promise<T | ElysiaCustomStatusResponse<304>> {
    const summary = mail.messageGetSummary(messageId);
    if (!summary) throw new ApiError(404, `Message '${messageId}' not found`);

    const etag = `"${summary.id}-${index}-${summary.date.getTime()}-${summary.size}${format ? `-${format}` : ''}"`;
    return answerRevalidated(request, set, etag, async () => serve(await mail.messageGetAttachment(messageId, index)));
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
