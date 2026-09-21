import { VCARD_CONTENT_TYPE } from '@workspace/lib/constants/contact';
import type { Contacts } from '../contacts/contacts';
import { davDeleteResponse, davPutResponse } from '../dav/write-result';
import { bookHref } from './discovery';

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
            'Content-Type': VCARD_CONTENT_TYPE,
            ETag: `"${card.etag}"`,
        },
    });
}

// PUT /dav/addressbooks/:ownerId/contacts/:uri — preconditions, UID rules and quota are putCard's, inside its lock.
export async function handlePutCard(
    contacts: Contacts,
    ownerId: string,
    uri: string,
    body: string,
    ifMatch: string | null,
    ifNoneMatch: string | null,
): Promise<Response> {
    const result = await contacts.putCard(uri, body, { ifMatch, ifNoneMatch });
    return davPutResponse(result, 'CARD', bookHref(ownerId), uri);
}

// DELETE /dav/addressbooks/:ownerId/contacts/:uri — your own card is a 403, mirroring deleteContact.
export async function handleDeleteCard(contacts: Contacts, uri: string, ifMatch: string | null): Promise<Response> {
    const result = await contacts.deleteCard(uri, { ifMatch });
    if (!result.ok && result.error === 'self-delete') return new Response('Forbidden', { status: 403 });
    return davDeleteResponse(result);
}
