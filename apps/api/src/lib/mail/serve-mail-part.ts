import { type EmailSummary, mailAttachmentName } from '@workspace/lib/types/mail';
import { ApiError, contentDisposition, etagMatches, parseByteRange, scriptableInlineHeaders } from '../core';
import type { Mail } from './mail-domain';

const MAIL_PART_CACHE_CONTROL = 'private, max-age=86400';

// The message id alone doesn't pin the bytes: a draft save rewrites the message under its existing id,
// re-delivering it as a fresh `<id>,S=<size>:2,<flags>` Maildir file. Date + size are what that rewrite
// changes, and unlike the filename they carry no comma — which etagMatches splits If-None-Match on.
function mailPartEtag(summary: EmailSummary, index: number): string {
    return `"${summary.id}-${index}-${summary.date.getTime()}-${summary.size}"`;
}

// Serves one parsed mail part, shared by the download and the embed route. The 304 is answered off the
// summary row BEFORE messageGetAttachment, which re-parses and decodes the whole .eml — a seeking media
// player would otherwise pay that parse on every range.
export async function serveMailPart(
    mail: Mail,
    messageId: string,
    index: number,
    disposition: 'attachment' | 'inline',
    request: Request,
): Promise<Response> {
    const summary = mail.messageGetSummary(messageId);
    if (!summary) throw new ApiError(404, `Message '${messageId}' not found`);

    const etag = mailPartEtag(summary, index);
    const ifNoneMatch = request.headers.get('if-none-match');
    if (ifNoneMatch && etagMatches(ifNoneMatch, etag)) {
        return new Response(null, { status: 304, headers: { ETag: etag, 'Cache-Control': MAIL_PART_CACHE_CONTROL } });
    }

    const att = await mail.messageGetAttachment(messageId, index);
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

    // The part is already in memory, so a range is two lines — mail video/audio parts reach a media
    // element whose seeking needs them, and Safari refuses a source that advertises none.
    const size = att.content.byteLength;
    const parsed = parseByteRange(request.headers.get('range'), size);
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
