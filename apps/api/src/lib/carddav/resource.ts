import { VCARD_CONTENT_TYPE } from '@workspace/lib/constants/contact';
import type { Contacts } from '../contacts/contacts';
import { davDeleteResponse, davPutResponse, davResourceResponse } from '../dav/write-result';
import { bookHref } from './discovery';

// GET /dav/addressbooks/:ownerId/contacts/:uri — the file IS the resource. A uri the index doesn't know is a 404.
export async function handleGetCard(contacts: Contacts, uri: string): Promise<Response> {
    const card = await contacts.getCard(uri);
    if (!card) return new Response('Not Found', { status: 404 });
    return davResourceResponse(card.bytes, card.etag, VCARD_CONTENT_TYPE);
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
