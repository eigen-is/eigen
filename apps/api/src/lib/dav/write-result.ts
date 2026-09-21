import { escapeXml } from '@workspace/lib/html';
import type { DeleteResourceResult, PutResourceResult } from '../core';
import { encodePathSegment } from './href';
import { davError } from './xml';

// CardDAV (RFC 6352 § 6.3.2.1) and CalDAV (RFC 4791 § 5.3.2.1) share these preconditions, so one mapping serves both.
export function davPutResponse(
    result: PutResourceResult,
    ns: 'C' | 'CARD',
    collectionHref: string,
    uri: string,
): Response {
    const href = (name: string) => `${collectionHref}${encodePathSegment(name)}`;
    if (result.ok) {
        // A body the server rewrote before storing it has no validator to carry: the client must re-read.
        const validator: Record<string, string> = result.etag ? { ETag: `"${result.etag}"` } : {};
        if (result.created) {
            return new Response(null, { status: 201, headers: { ...validator, Location: href(uri) } });
        }
        return new Response(null, { status: 204, headers: validator });
    }
    if (result.error === 'precondition') return new Response('Precondition Failed', { status: 412 });
    // 409, not 403: the user can retire the other resource and resubmit (RFC 4918 § 16).
    if (result.error === 'uid-conflict') {
        return davError(
            409,
            result.conflictUri
                ? `<${ns}:no-uid-conflict><D:href>${escapeXml(href(result.conflictUri))}</D:href></${ns}:no-uid-conflict>`
                : `<${ns}:no-uid-conflict/>`,
        );
    }
    if (result.error === 'too-large') return davError(413, `<${ns}:max-resource-size/>`);
    if (result.error === 'quota') return new Response('Insufficient Storage', { status: 507 });
    return new Response(result.message ?? 'Bad Request', { status: 400 });
}

// An unknown uri is a 404 — a DAV DELETE is deliberately not idempotent.
export function davDeleteResponse(result: DeleteResourceResult): Response {
    if (result.ok) return new Response(null, { status: 204 });
    if (result.error === 'not-found') return new Response('Not Found', { status: 404 });
    return new Response('Precondition Failed', { status: 412 });
}
