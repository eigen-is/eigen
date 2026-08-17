import { uriKeyOf } from '../contacts/card-store';
import type { CardRow, Contacts } from '../contacts/contacts';
import { projectAddressData } from './address-data';
import { bookHref, cardHref } from './discovery';
import { matchCard, UnsupportedCollationError, UnsupportedFilterError } from './query-filter';
import { parseVCardLines, type VCardLine } from './vcard-ast';
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
// multiget refuses a client that asks for more than this many resources in one round-trip, and a query result
// set is truncated to the cap rather than assembling an unbounded response.
export const REPORT_BODY_MAX_BYTES = 1_048_576;
const MULTIGET_HREF_LIMIT = 500;
const QUERY_RESULT_CAP = 1000;

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

// A 403 carrying a single CardDAV precondition element (CARD:supported-collation / CARD:supported-filter). RFC
// 6352 § 8.6 requires match-only query responses, so an unevaluable filter is refused rather than answered with
// a superset a client would treat as all-matching.
function davPrecondition(element: string): Response {
    return new Response(
        `<?xml version="1.0" encoding="utf-8"?><D:error xmlns:D="DAV:" xmlns:CARD="urn:ietf:params:xml:ns:carddav"><CARD:${element}/></D:error>`,
        { status: 403, headers: { 'Content-Type': XML_CONTENT_TYPE } },
    );
}

// REPORT on /dav/addressbooks/:ownerId/contacts/ — addressbook-multiget, addressbook-query, or sync-collection.
export async function handleCardReport(contacts: Contacts, ownerId: string, body: string): Promise<Response> {
    let report: CardReportRequest;
    try {
        report = parseCardReport(body);
    } catch (e) {
        // The filter parser throws these two when a query names an unsupported collation or an unmappable
        // element; everything else (malformed XML, unknown root) is a plain 400.
        if (e instanceof UnsupportedCollationError) return davPrecondition('supported-collation');
        if (e instanceof UnsupportedFilterError) return davPrecondition('supported-filter');
        return new Response('Bad Request: invalid REPORT', { status: 400 });
    }

    switch (report.type) {
        case 'addressbook-multiget':
            return handleMultiget(contacts, ownerId, report);
        case 'sync-collection':
            return handleSyncCollection(contacts, ownerId, report);
        case 'addressbook-query':
            return handleQuery(contacts, ownerId, report);
    }
}

// The address-data body a REPORT row serves: the full stored bytes, or — when the client asked for a property
// subset (partial retrieval, RFC 6352 § 10.4.2) — the projection down to that subset plus the mandatory
// skeleton. partialProps is null for full retrieval (the parser never yields an empty list), so a non-empty
// subset is the only projection trigger. A stored card that won't parse can't be projected, so it's served
// whole rather than 500-ing the whole REPORT — the same skip-on-throw stance the query loop takes below.
function resolveAddressData(bytes: Uint8Array, partialProps: string[] | null): string {
    const text = new TextDecoder().decode(bytes);
    if (!partialProps?.length) return text;
    try {
        return projectAddressData(text, partialProps);
    } catch {
        return text;
    }
}

async function handleMultiget(
    contacts: Contacts,
    ownerId: string,
    report: Extract<CardReportRequest, { type: 'addressbook-multiget' }>,
): Promise<Response> {
    if (report.hrefs.length > MULTIGET_HREF_LIMIT) return new Response('Too many hrefs', { status: 400 });

    const prefix = bookHref(ownerId);
    const responses: string[] = [];
    // One response per resource: a client that lists the same href N times (or spells it N equivalent ways)
    // must not make us retain N copies of one card's bytes during assembly — the 500-count cap bounds the
    // request shape, this dedupe re-anchors the response size to the (quota-bounded) book. Keyed by the folded
    // uri for a resolvable href, by the raw href (uriKeys never contain ':') for an unresolvable one, so a
    // repeated 404 collapses too. First occurrence wins, preserving request order.
    const seen = new Set<string>();
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
        const dedupeKey = uri ? uriKeyOf(uri) : `raw:${href}`;
        if (seen.has(dedupeKey)) continue;
        seen.add(dedupeKey);
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
        // Full bytes verbatim, or the partial-retrieval projection when the client asked for a prop subset.
        if (report.wantsData) props.push(addressDataProp(resolveAddressData(card.bytes, report.partialProps)));
        responses.push(response(cardHref(ownerId, uri), [propstatOk(props)]));
    }
    return xmlResponse(responses);
}

// addressbook-query: match-only server-side filtering (RFC 6352 § 8.6 — clients treat every returned card as a
// match). Matching runs in-memory over every parsed card, group cards included (DAV sees the whole book); books
// are small and queries rare, so this never touches an app hot path (spec § Performance).
async function handleQuery(
    contacts: Contacts,
    ownerId: string,
    report: Extract<CardReportRequest, { type: 'addressbook-query' }>,
): Promise<Response> {
    // RFC 6352 § 8.6 requires a CARDDAV:filter in the report; a body without one is malformed.
    if (!report.filter) return new Response('Bad Request: addressbook-query requires a filter', { status: 400 });
    const filter = report.filter;

    // Each card's bytes are read once and kept, so a matching card is never fetched twice (the query's payload
    // is the card, like multiget).
    const matched: { uri: string; etag: string; bytes: Uint8Array }[] = [];
    for (const card of await contacts.listCards()) {
        const got = await contacts.getCard(card.uri);
        if (!got) continue; // vanished under us — the drain tombstones it, this query just skips it
        let lines: VCardLine[];
        try {
            lines = parseVCardLines(new TextDecoder().decode(got.bytes));
        } catch {
            continue; // a stored card that won't parse can't match a filter (the same-stat replacement edge)
        }
        if (matchCard(lines, filter)) matched.push({ uri: card.uri, etag: got.etag, bytes: got.bytes });
    }

    // Client limit first, then the server cap: over the cap we truncate and log once rather than assemble an
    // unbounded response (spec § 4 pins truncate + log).
    let results = matched;
    if (report.limit !== null && results.length > report.limit) results = results.slice(0, report.limit);
    if (results.length > QUERY_RESULT_CAP) {
        console.warn(`carddav: addressbook-query matched ${results.length} cards, truncating to ${QUERY_RESULT_CAP}`);
        results = results.slice(0, QUERY_RESULT_CAP);
    }

    const responses = results.map((r) => {
        const props = [...cardEtagProp(r.etag)];
        // Full bytes verbatim, or the partial-retrieval projection when the client asked for a prop subset.
        if (report.wantsData) props.push(addressDataProp(resolveAddressData(r.bytes, report.partialProps)));
        return response(cardHref(ownerId, r.uri), [propstatOk(props)]);
    });
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
