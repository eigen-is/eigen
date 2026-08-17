import type { Contacts } from '../contacts/contacts';
import { cardHref } from './discovery';
import { davError } from './xml-builder';

// GET /dav/addressbooks/:ownerId/contacts/:uri — the stored bytes verbatim (the file IS the resource), with the
// content hash as a quoted ETag. A uri the index doesn't know is a 404.
export async function handleGetCard(contacts: Contacts, uri: string): Promise<Response> {
    const card = await contacts.getCard(uri);
    if (!card) return new Response('Not Found', { status: 404 });
    // Copy into an ArrayBuffer-backed view: storage.bytes() is Uint8Array<ArrayBufferLike>, which the Response
    // BodyInit type rejects (it could be SharedArrayBuffer-backed). A card is ≤ 5 MiB and GET is rare.
    return new Response(new Uint8Array(card.bytes), {
        status: 200,
        headers: {
            'Content-Type': 'text/vcard; charset=utf-8',
            ETag: `"${card.etag}"`,
        },
    });
}

// PUT /dav/addressbooks/:ownerId/contacts/:uri — store the client's card and map the typed PutCardResult to its
// HTTP status. Preconditions, UID rules, quota, transcode, and the self-link decision all live in putCard,
// evaluated inside the mutation lock (§ 3); this only translates the outcome. The etag hashes the stored bytes,
// so a 4.0 client that PUT gets the 3.0 form's etag back and re-converges on its next fetch.
export async function handlePutCard(
    contacts: Contacts,
    ownerId: string,
    uri: string,
    body: string,
    ifMatch: string | null,
    ifNoneMatch: string | null,
): Promise<Response> {
    const result = await contacts.putCard(uri, body, { ifMatch, ifNoneMatch });
    if (result.ok) {
        if (result.created) {
            return new Response(null, {
                status: 201,
                headers: {
                    ETag: `"${result.etag}"`,
                    Location: cardHref(ownerId, uri),
                },
            });
        }
        return new Response(null, { status: 204, headers: { ETag: `"${result.etag}"` } });
    }
    if (result.error === 'precondition') return new Response('Precondition Failed', { status: 412 });
    // RFC 6352 precondition bodies: no-uid-conflict for a UID a different resource already owns (§ 6.3.2),
    // max-resource-size for a PUT over the advertised ceiling (§ 6.2.3).
    if (result.error === 'uid-conflict') return davError(412, '<CARD:no-uid-conflict/>');
    if (result.error === 'too-large') return davError(413, '<CARD:max-resource-size/>');
    if (result.error === 'quota') return new Response('Insufficient Storage', { status: 507 });
    return new Response(result.message ?? 'Bad Request', { status: 400 });
}

// DELETE /dav/addressbooks/:ownerId/contacts/:uri — remove the resource. An unknown uri is a 404 (DAV DELETE is
// not idempotent), a stale If-Match a 412, and your own card a 403 (mirrors deleteContact).
export async function handleDeleteCard(contacts: Contacts, uri: string, ifMatch: string | null): Promise<Response> {
    const result = await contacts.deleteCard(uri, { ifMatch });
    if (result.ok) return new Response(null, { status: 204 });
    if (result.error === 'not-found') return new Response('Not Found', { status: 404 });
    if (result.error === 'precondition') return new Response('Precondition Failed', { status: 412 });
    return new Response('Forbidden', { status: 403 });
}
