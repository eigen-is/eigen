import { escapeXml } from '@workspace/lib/html';
import type { DeleteResourceResult, InvalidReason, PutResourceResult } from '../core';
import { encodePathSegment } from './href';
import { davError } from './xml';

// The precondition each rejection carries, in the vocabulary of the protocol answering it: CardDAV has one
// element for a body it will not store, CalDAV names the rule that was broken (RFC 6352 § 6.3.2.1,
// RFC 4791 § 5.3.2.1).
const PRECONDITIONS: Record<'C' | 'CARD', Record<InvalidReason, string>> = {
    C: {
        data: 'valid-calendar-data',
        object: 'valid-calendar-object-resource',
        component: 'supported-calendar-component',
    },
    CARD: { data: 'valid-address-data', object: 'valid-address-data', component: 'valid-address-data' },
};

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
    // A PUT under a collection that does not exist is a 409, not a 400 (RFC 4918 § 9.7.1).
    if (result.error === 'no-collection') return new Response('Conflict', { status: 409 });
    if (result.reason) return davError(403, `<${ns}:${PRECONDITIONS[ns][result.reason]}/>`);
    return new Response(result.message ?? 'Bad Request', { status: 400 });
}

// An unknown uri is a 404 — a DAV DELETE is deliberately not idempotent.
export function davDeleteResponse(result: DeleteResourceResult): Response {
    if (result.ok) return new Response(null, { status: 204 });
    if (result.error === 'not-found') return new Response('Not Found', { status: 404 });
    return new Response('Precondition Failed', { status: 412 });
}
