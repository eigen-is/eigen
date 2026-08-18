import { uriKeyOf } from '../contacts/card-store';
import type { Contacts } from '../contacts/contacts';
import type { CardRow } from '../contacts/dav-store';
import { projectAddressData } from './address-data';
import { bookHref, cardHref } from './discovery';
import { matchCard, UnsupportedCollationError, UnsupportedFilterError } from './query-filter';
import { parseVCardLines, type VCardLine } from './vcard-ast';
import {
    addressDataProp,
    cardEtagProp,
    davError,
    formatSyncToken,
    multistatusResponse,
    parseSyncToken,
    propstatNotFound,
    propstatOk,
    response,
} from './xml-builder';
import { type CardReportRequest, parseCardReport } from './xml-parser';

// Request bounds (spec § 4): the router rejects a REPORT body over this before it reaches the XML unfolder,
// multiget refuses a client that asks for more than this many resources in one round-trip, and a query result
// set is truncated to the cap rather than assembling an unbounded response.
export const REPORT_BODY_MAX_BYTES = 1_048_576;
const MULTIGET_HREF_LIMIT = 500;
const QUERY_RESULT_CAP = 1000;

// RFC 6578 recovery: a token the book can't honour (stale generation, future ctag, or malformed) forces the
// client to redo the full comparison. sabre answers 403 (InvalidSyncToken extends Forbidden) with
// D:valid-sync-token; RFC 3253 § 1.6 marshals precondition failures as 403, and clients key full resync on it.
const invalidSyncToken = () => davError(403, '<D:valid-sync-token/>');

// REPORT on /dav/addressbooks/:ownerId/contacts/ — addressbook-multiget, addressbook-query, or sync-collection.
export async function handleCardReport(contacts: Contacts, ownerId: string, body: string): Promise<Response> {
    let report: CardReportRequest;
    try {
        report = parseCardReport(body);
    } catch (e) {
        // The filter parser throws these two when a query names an unsupported collation or an unmappable
        // element. RFC 6352 § 8.6 requires match-only query responses, so an unevaluable filter is refused
        // with its precondition rather than answered with a superset a client would treat as all-matching;
        // everything else (malformed XML, unknown root) is a plain 400.
        if (e instanceof UnsupportedCollationError) return davError(403, '<CARD:supported-collation/>');
        if (e instanceof UnsupportedFilterError) return davError(403, '<CARD:supported-filter/>');
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

// The address-data body a REPORT row serves: the full stored text, or — when the client asked for a property
// subset (partial retrieval, RFC 6352 § 10.4.2) — the projection down to that subset plus the mandatory
// skeleton. partialProps is null for full retrieval (the parser never yields an empty list), so a non-empty
// subset is the only projection trigger. A stored card that won't parse can't be projected, so it's served
// whole rather than 500-ing the whole REPORT — the same skip-on-throw stance the query loop takes below.
function resolveAddressData(text: string, partialProps: string[] | null): string {
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
    // One response per resource: a client listing one href N ways must not make us retain N copies of the
    // card's bytes — the 500-count cap bounds the request, this dedupe re-anchors the response to the book.
    // Keyed by folded uri when resolvable, by `raw:`+href otherwise so repeated 404s collapse too; stored
    // uris can't contain ':' (sanitizeCardUri), so a raw: key never shadows a real card. First occurrence
    // wins, preserving request order.
    const seen = new Set<string>();
    for (const href of report.hrefs) {
        // Normalise an absolute-path href down to the book prefix (the caldav report.ts move), then percent-decode
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
        if (report.wantsData) {
            props.push(addressDataProp(resolveAddressData(new TextDecoder().decode(card.bytes), report.partialProps)));
        }
        responses.push(response(cardHref(ownerId, uri), [propstatOk(props)]));
    }
    return multistatusResponse(responses);
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

    // The limit and cap bound the ASSEMBLY, not just the response: matching stops at the cap instead of
    // retaining every remaining match's bytes (spec § 4 pins truncate + log). Book order is kept, so the
    // served set equals slicing afterwards.
    const cap = Math.min(report.limit ?? QUERY_RESULT_CAP, QUERY_RESULT_CAP);
    const matched: { uri: string; etag: string; text: string }[] = [];
    for (const card of await contacts.listCards()) {
        if (matched.length >= cap) {
            if (cap === QUERY_RESULT_CAP) {
                console.warn(`carddav: addressbook-query hit the ${QUERY_RESULT_CAP}-result cap, truncating`);
            }
            break;
        }
        const got = await contacts.getCard(card.uri);
        if (!got) continue; // vanished under us — the drain tombstones it, this query just skips it
        const text = new TextDecoder().decode(got.bytes);
        let lines: VCardLine[];
        try {
            lines = parseVCardLines(text);
        } catch {
            continue; // a stored card that won't parse can't match a filter (the same-stat replacement edge)
        }
        if (matchCard(lines, filter)) matched.push({ uri: card.uri, etag: got.etag, text });
    }

    const responses = matched.map((r) => {
        const props = [...cardEtagProp(r.etag)];
        // Full text verbatim, or the partial-retrieval projection when the client asked for a prop subset.
        if (report.wantsData) props.push(addressDataProp(resolveAddressData(r.text, report.partialProps)));
        return response(cardHref(ownerId, r.uri), [propstatOk(props)]);
    });
    return multistatusResponse(responses);
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
        const token = parseSyncToken(report.syncToken);
        if (!token) return invalidSyncToken();
        // A stale generation (index rebuilt → syncGen rotated) OR a ctag ahead of the book both force a clean
        // full resync — answering a post-restore future token with an empty delta and a LOWER token would
        // stall that client permanently (the live CalDAV bug this branch also fixed, caldav/report.ts).
        if (token.gen !== book.syncGen || token.since > book.ctag) return invalidSyncToken();

        for (const card of await contacts.getChangedCardsSince(token.since)) {
            responses.push(await cardRow(contacts, ownerId, card, report.wantsData));
        }
        // One tombstone row per uri (the tombstone PK + putCard's tombstone-clear on recreate guarantee no
        // href appears as both a 200 and a 404 in one response — the dup-href CalDAV bug this branch fixed at
        // the calendar's three tombstone sites).
        for (const d of await contacts.getDeletedCardsSince(token.since)) {
            responses.push(response(cardHref(ownerId, d.uri), ['<D:status>HTTP/1.1 404 Not Found</D:status>']));
        }
    }

    // RFC 6578: the current token is appended after the responses.
    return multistatusResponse(responses, `<D:sync-token>${formatSyncToken(book)}</D:sync-token>`);
}

async function cardRow(contacts: Contacts, ownerId: string, card: CardRow, wantsData: boolean): Promise<string> {
    const props = [...cardEtagProp(card.etag)];
    if (wantsData) {
        const got = await contacts.getCard(card.uri);
        if (got) props.push(addressDataProp(new TextDecoder().decode(got.bytes)));
    }
    return response(cardHref(ownerId, card.uri), [propstatOk(props)]);
}
