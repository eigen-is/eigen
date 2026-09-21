import { VCARD_CONTENT_TYPE } from '@workspace/lib/constants/contact';
import type { Contacts } from '../contacts/contacts';
import type { CardRow } from '../contacts/dav-store';
import { uriKeyOf } from '../core';
import { MULTIGET_HREF_LIMIT, resolveMultigetHrefs } from '../dav/href';
import { type DataBudget, REPORT_DATA_BUDGET_BYTES, resourceDataRow } from '../dav/report-row';
import { formatSyncToken, invalidSyncToken, parseSyncToken } from '../dav/sync-token';
import { davError, multistatusResponse, notFoundRow, removedRow } from '../dav/xml';
import { parseVCardLines } from '../vcard';
import type { VCardLine } from '../vcard/types';
import { projectAddressData } from './address-data';
import { bookHref, cardHref } from './discovery';
import { matchCard, UnsupportedCollationError, UnsupportedFilterError } from './query-filter';
import { addressDataProp } from './xml-builder';
import { type CardReportRequest, parseCardReport } from './xml-parser';

// Caps a query result set so a book of any size cannot assemble an unbounded response.
const QUERY_RESULT_CAP = 1000;

// REPORT on /dav/addressbooks/:ownerId/contacts/ — addressbook-multiget, addressbook-query, or sync-collection.
export async function handleCardReport(contacts: Contacts, ownerId: string, body: string): Promise<Response> {
    let report: CardReportRequest;
    try {
        report = parseCardReport(body);
    } catch (e) {
        // RFC 6352 § 8.6 requires match-only responses, so an unevaluable filter is refused, never answered with a superset.
        if (e instanceof UnsupportedCollationError) return davError(403, '<CARD:supported-collation/>');
        if (e instanceof UnsupportedFilterError) return davError(403, '<CARD:supported-filter/>');
        return new Response('Bad Request: invalid REPORT', { status: 400 });
    }

    const budget = { left: REPORT_DATA_BUDGET_BYTES };
    switch (report.type) {
        case 'addressbook-multiget':
            return handleMultiget(contacts, ownerId, report, budget);
        case 'sync-collection':
            return handleSyncCollection(contacts, ownerId, report, budget);
        case 'addressbook-query':
            return handleQuery(contacts, ownerId, report, budget);
    }
}

// A stored card that will not parse cannot be projected, so it is served whole rather than failing the REPORT.
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
    budget: DataBudget,
): Promise<Response> {
    if (report.hrefs.length > MULTIGET_HREF_LIMIT) return new Response('Too many hrefs', { status: 400 });

    // Cards fold by uri key, so two spellings of one name yield one row (the shared resolver's `keyOf`).
    const responses: string[] = [];
    for (const { uri, href } of resolveMultigetHrefs(report.hrefs, bookHref(ownerId), uriKeyOf)) {
        if (uri === null) {
            responses.push(notFoundRow(href));
            continue;
        }

        const row = await contacts.getCardMeta(uri);
        if (!row) {
            responses.push(notFoundRow(cardHref(ownerId, uri)));
            continue;
        }
        responses.push(await cardRow(contacts, ownerId, row, report.wantsData, report.partialProps, budget));
    }
    return multistatusResponse(responses);
}

// Matching runs in-memory over the whole book (RFC 6352 § 8.6 is match-only); books are small and queries rare.
async function handleQuery(
    contacts: Contacts,
    ownerId: string,
    report: Extract<CardReportRequest, { type: 'addressbook-query' }>,
    budget: DataBudget,
): Promise<Response> {
    // RFC 6352 § 8.6 requires a CARDDAV:filter in the report; a body without one is malformed.
    if (!report.filter) return new Response('Bad Request: addressbook-query requires a filter', { status: 400 });

    // Matching stops at the cap, so the assembly is bounded too, not just the response (docs/CONTACTS.md § CardDAV surface).
    const cap = Math.min(report.limit ?? QUERY_RESULT_CAP, QUERY_RESULT_CAP);
    const matched: { row: CardRow; served: { bytes: Uint8Array; etag: string } }[] = [];
    for (const card of await contacts.listCards()) {
        if (matched.length >= cap) {
            if (cap === QUERY_RESULT_CAP) {
                console.warn(`carddav: addressbook-query hit the ${QUERY_RESULT_CAP}-result cap, truncating`);
            }
            break;
        }
        const got = await contacts.getCard(card.uri);
        if (!got) continue; // vanished under us — the drain tombstones it, this query just skips it
        let lines: VCardLine[];
        try {
            lines = parseVCardLines(new TextDecoder().decode(got.bytes));
        } catch {
            continue; // a stored card that won't parse can't match a filter (the same-stat replacement edge)
        }
        if (matchCard(lines, report.filter)) matched.push({ row: card, served: got });
    }

    const responses: string[] = [];
    for (const { row, served } of matched) {
        // The bytes matching read are the bytes this row serves, so the budget spends them without a re-read.
        responses.push(
            await cardRow(contacts, ownerId, row, report.wantsData, report.partialProps, budget, async () => served),
        );
    }
    return multistatusResponse(responses);
}

async function handleSyncCollection(
    contacts: Contacts,
    ownerId: string,
    report: Extract<CardReportRequest, { type: 'sync-collection' }>,
    budget: DataBudget,
): Promise<Response> {
    const book = await contacts.getBook();
    const responses: string[] = [];

    if (!report.syncToken) {
        // Initial sync — the whole book as 200 rows.
        for (const card of await contacts.listCards()) {
            responses.push(await cardRow(contacts, ownerId, card, report.wantsData, null, budget));
        }
    } else {
        const token = parseSyncToken(report.syncToken);
        if (!token) return invalidSyncToken();
        // A stale generation or a token ahead of the ctag forces a full resync; an empty delta with a lower token stalls a client.
        if (token.gen !== book.syncGen || token.since > book.ctag) return invalidSyncToken();

        for (const card of await contacts.getChangedCardsSince(token.since)) {
            responses.push(await cardRow(contacts, ownerId, card, report.wantsData, null, budget));
        }
        // One tombstone row per uri: no href may appear as both a 200 and a 404 in one response.
        for (const d of await contacts.getDeletedCardsSince(token.since)) {
            responses.push(removedRow(cardHref(ownerId, d.uri)));
        }
    }

    // RFC 6578: the current token is appended after the responses.
    return multistatusResponse(responses, `<D:sync-token>${formatSyncToken(book)}</D:sync-token>`);
}

// A row normally reads its own file; the query passes the bytes it already matched, so its cards are read once.
async function cardRow(
    contacts: Contacts,
    ownerId: string,
    card: CardRow,
    wantsData: boolean,
    partialProps: string[] | null,
    budget: DataBudget,
    read: () => Promise<{ bytes: Uint8Array; etag: string } | null> = () => contacts.getCard(card.uri),
): Promise<string> {
    return resourceDataRow({
        href: cardHref(ownerId, card.uri),
        row: card,
        contentType: VCARD_CONTENT_TYPE,
        wantsData,
        dataElement: '<CARD:address-data/>',
        dataProp: (text) => addressDataProp(resolveAddressData(text, partialProps)),
        read,
        budget,
    });
}
