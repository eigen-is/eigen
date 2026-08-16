import type { CardRow, Contacts } from '../contacts/contacts';
import { ADDRESSBOOK_ID } from './discovery';
import {
    addressDataProp,
    cardEtagProp,
    multistatus,
    propstatNotFound,
    propstatOk,
    response,
    XML_CONTENT_TYPE,
} from './xml-builder';
import { type CardReportRequest, parseCardReport } from './xml-parser';

// Request bounds (spec § 4): the router rejects a REPORT body over this before it reaches the XML unfolder,
// and multiget refuses a client that asks for more than this many resources in one round-trip.
export const REPORT_BODY_MAX_BYTES = 1_048_576;
const MULTIGET_HREF_LIMIT = 500;

const bookPrefix = (ownerId: string) => `/dav/addressbooks/${ownerId}/${ADDRESSBOOK_ID}/`;
// Card names are client-chosen, so every emitted href percent-encodes the resource segment — the
// webdav/xml.ts:53 convention the CalDAV template skips (its uris are server-generated). Mirrors discovery.ts.
const cardHref = (ownerId: string, uri: string) => `${bookPrefix(ownerId)}${encodeURIComponent(uri)}`;

function xmlResponse(responses: string[], extra?: string): Response {
    return new Response(multistatus(responses, extra), {
        status: 207,
        headers: { 'Content-Type': XML_CONTENT_TYPE },
    });
}

// RFC 6578 recovery: a token the book can't honour (stale generation, future ctag, or malformed) forces the
// client to redo the full comparison. sabre answers 412 with D:valid-sync-token; the design follows it (§ 1).
function invalidSyncToken(): Response {
    return new Response(
        `<?xml version="1.0" encoding="utf-8"?><D:error xmlns:D="DAV:"><D:valid-sync-token/></D:error>`,
        { status: 412, headers: { 'Content-Type': XML_CONTENT_TYPE } },
    );
}

// REPORT on /dav/addressbooks/:ownerId/contacts/ — addressbook-multiget, addressbook-query, or sync-collection.
export async function handleCardReport(contacts: Contacts, ownerId: string, body: string): Promise<Response> {
    let report: CardReportRequest;
    try {
        report = parseCardReport(body);
    } catch {
        return new Response('Bad Request: invalid REPORT', { status: 400 });
    }

    switch (report.type) {
        case 'addressbook-multiget':
            return handleMultiget(contacts, ownerId, report);
        case 'sync-collection':
            return handleSyncCollection(contacts, ownerId, report);
        case 'addressbook-query':
            // The addressbook-query filter engine is Task 17. Until it lands, every query REPORT — with a
            // filter or not — is answered with the honest supported-filter precondition rather than a
            // full-set superset, which RFC 6352 § 8.6 forbids (clients treat every returned card as a match).
            return new Response(
                `<?xml version="1.0" encoding="utf-8"?><D:error xmlns:D="DAV:" xmlns:CARD="urn:ietf:params:xml:ns:carddav"><CARD:supported-filter/></D:error>`,
                { status: 403, headers: { 'Content-Type': XML_CONTENT_TYPE } },
            );
    }
}

async function handleMultiget(
    contacts: Contacts,
    ownerId: string,
    report: Extract<CardReportRequest, { type: 'addressbook-multiget' }>,
): Promise<Response> {
    if (report.hrefs.length > MULTIGET_HREF_LIMIT) return new Response('Too many hrefs', { status: 400 });

    const prefix = bookPrefix(ownerId);
    const responses: string[] = [];
    for (const href of report.hrefs) {
        // Normalise an absolute-path href down to the book prefix (caldav report.ts:72-75), then percent-decode
        // the single resource segment. A malformed escape or a href outside this book is a 404 row, not a throw.
        const normalized = href.replace(/^\/+/, '/');
        const encodedUri = normalized.startsWith(prefix) ? normalized.slice(prefix.length) : '';
        let uri = '';
        if (encodedUri) {
            try {
                uri = decodeURIComponent(encodedUri);
            } catch {
                uri = '';
            }
        }
        if (!uri) {
            responses.push(response(href, [propstatNotFound(['<D:getetag/>'])]));
            continue;
        }

        const card = await contacts.getCard(uri);
        if (!card) {
            responses.push(response(cardHref(ownerId, uri), [propstatNotFound(['<D:getetag/>'])]));
            continue;
        }
        const props = [...cardEtagProp(card.etag)];
        // Task 16 serves full bytes verbatim; the partialProps projection is Task 18.
        if (report.wantsData) props.push(addressDataProp(new TextDecoder().decode(card.bytes)));
        responses.push(response(cardHref(ownerId, uri), [propstatOk(props)]));
    }
    return xmlResponse(responses);
}

async function handleSyncCollection(
    contacts: Contacts,
    ownerId: string,
    report: Extract<CardReportRequest, { type: 'sync-collection' }>,
): Promise<Response> {
    const book = await contacts.getBook();
    const responses: string[] = [];

    if (!report.syncToken) {
        // Initial sync — the whole book as 200 rows.
        for (const card of await contacts.listCards()) {
            responses.push(await cardRow(contacts, ownerId, card, report.wantsData));
        }
    } else {
        const m = /^urn:eigen:sync:(\d+)-(\d+)$/.exec(report.syncToken);
        if (!m) return invalidSyncToken();
        const gen = Number(m[1]);
        const since = Number(m[2]);
        // A stale generation (index rebuilt → syncGen rotated) OR a ctag ahead of the book both force a clean
        // full resync — the latter is the CalDAV bug the design must not inherit (report.ts:139-166 answers a
        // post-rebuild future token with an empty delta and a LOWER token, permanently stalling that client).
        if (gen !== book.syncGen || since > book.ctag) return invalidSyncToken();

        for (const card of await contacts.getChangedCardsSince(since)) {
            responses.push(await cardRow(contacts, ownerId, card, report.wantsData));
        }
        // One tombstone row per uri (the tombstone PK + putCard's tombstone-clear on recreate guarantee no
        // href appears as both a 200 and a 404 in one response — the other CalDAV bug the design must not inherit).
        for (const d of await contacts.getDeletedCardsSince(since)) {
            responses.push(response(cardHref(ownerId, d.uri), ['<D:status>HTTP/1.1 404 Not Found</D:status>']));
        }
    }

    // RFC 6578: the current token is appended after the responses.
    const token = `urn:eigen:sync:${book.syncGen}-${book.ctag}`;
    return xmlResponse(responses, `<D:sync-token>${token}</D:sync-token>`);
}

async function cardRow(contacts: Contacts, ownerId: string, card: CardRow, wantsData: boolean): Promise<string> {
    const props = [...cardEtagProp(card.etag)];
    if (wantsData) {
        const got = await contacts.getCard(card.uri);
        if (got) props.push(addressDataProp(new TextDecoder().decode(got.bytes)));
    }
    return response(cardHref(ownerId, card.uri), [propstatOk(props)]);
}
