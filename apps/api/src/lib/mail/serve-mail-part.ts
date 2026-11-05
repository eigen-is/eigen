// How a mail route answers with one part of a message: its bytes for the download and embed routes, or the
// preview a route renders from them. It decides whether the browser may keep the answer. The mail routes
// that serve parts and their previews call it on every request.

import type { Attachment } from '@workspace/lib/types/mail';
import { mailAttachmentName } from '@workspace/lib/types/mail';
import type { ElysiaCustomStatusResponse } from 'elysia';
import { ApiError, answerRevalidated, contentDisposition, rangeResponse, scriptableInlineHeaders } from '../core';
import type { Mail } from './mail-domain';

// A draft save rewrites the message under its id, so a draft's part is never stored. Any other message never
// changes under its id, so a 304 is answered before the .eml is read. A preview passes its renderer's format
// tag, so a renderer fix is not answered with a 304.
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
    const produce = async () => serve(await mail.messageGetAttachment(messageId, index));
    if (summary.isDraft) {
        set.headers['Cache-Control'] = 'no-store';
        return produce();
    }
    return answerRevalidated(request, set, `"${summary.id}-${index}${format ? `-${format}` : ''}"`, produce);
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
