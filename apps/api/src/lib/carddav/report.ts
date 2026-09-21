import type { Contacts } from '../contacts/contacts';
import type { CardRow } from '../contacts/dav-store';
import { uriKeyOf } from '../core';
import { MULTIGET_HREF_LIMIT, resolveMultigetHrefs } from '../dav/href';
import { parseVCardLines } from '../vcard';
import type { VCardLine } from '../vcard/types';
import { projectAddressData } from './address-data';
import { bookHref, cardHref } from './discovery';
import { matchCard, UnsupportedCollationError, UnsupportedFilterError } from './query-filter';
import {
    addressDataProp,
    cardEtagProp,
    davError,
    formatSyncToken,
    invalidSyncToken,
    multistatusResponse,
    parseSyncToken,
    propstatNotFound,
    propstatOk,
    response,
} from './xml-builder';
import { type CardReportRequest, parseCardReport } from './xml-parser';

// A query result set is truncated to this cap rather than assembling an unbounded response. The multiget
// round-trip bound is the shared MULTIGET_HREF_LIMIT, and the body ceiling the shared DAV_BODY_MAX_BYTES,
// enforced in the router before the body reaches the XML unfolder.
const QUERY_RESULT_CAP = 1000;

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
    if (!partialProps) return text;
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

    // Cards fold by uri key, so two spellings of one name yield one row (the shared resolver's `keyOf`).
    const responses: string[] = [];
    for (const { uri, href } of resolveMultigetHrefs(report.hrefs, bookHref(ownerId), uriKeyOf)) {
        if (uri === null) {
            responses.push(response(href, [propstatNotFound(['<D:getetag/>'])]));
            continue;
        }

        const card = await contacts.getCard(uri);
        if (!card) {
            responses.push(response(cardHref(ownerId, uri), [propstatNotFound(['<D:getetag/>'])]));
            continue;
        }
        const props = [...cardEtagProp(card.etag)];
        if (report.wantsData) {
            props.push(addressDataProp(resolveAddressData(new TextDecoder().decode(card.bytes), report.partialProps)));
        }
        responses.push(response(cardHref(ownerId, uri), [propstatOk(props)]));
    }
    return multistatusResponse(responses);
}

// addressbook-query: match-only server-side filtering (RFC 6352 § 8.6 — clients treat every returned card as a
// match). Matching runs in-memory over every parsed card, group cards included (DAV sees the whole book); books
// are small and queries rare, so this never touches an app hot path.
async function handleQuery(
    contacts: Contacts,
    ownerId: string,
    report: Extract<CardReportRequest, { type: 'addressbook-query' }>,
): Promise<Response> {
    // RFC 6352 § 8.6 requires a CARDDAV:filter in the report; a body without one is malformed.
    if (!report.filter) return new Response('Bad Request: addressbook-query requires a filter', { status: 400 });

    // The limit and cap bound the ASSEMBLY, not just the response: matching stops at the cap instead of
    // retaining every remaining match's bytes (truncate + log, docs/CONTACTS.md § CardDAV surface). Book order
    // is kept, so the served set equals slicing afterwards.
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
        if (matchCard(lines, report.filter)) matched.push({ uri: card.uri, etag: got.etag, text });
    }

    const responses = matched.map((r) => {
        const props = [...cardEtagProp(r.etag)];
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

// A row that also serves the card body quotes the etag of the bytes it read, never the index row's: the two
// must describe one revision. Without address-data nothing is read, so the row's etag is what there is.
async function cardRow(contacts: Contacts, ownerId: string, card: CardRow, wantsData: boolean): Promise<string> {
    const got = wantsData ? await contacts.getCard(card.uri) : null;
    const props = [...cardEtagProp(got?.etag ?? card.etag)];
    if (got) props.push(addressDataProp(new TextDecoder().decode(got.bytes)));
    return response(cardHref(ownerId, card.uri), [propstatOk(props)]);
}
