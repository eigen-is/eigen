import { XMLParser } from 'fast-xml-parser';

// Same config as caldav/xml-parser.ts (removeNSPrefix drops the D:/CARD: prefixes so lookups stay
// prefix-agnostic) with one difference the CardDAV reports force (review finding 5): the isArray callback is
// jPath-aware. `href` is always a list. `prop` is a list ONLY as the partial-retrieval child of
// `address-data` (jPath `…address-data.prop`) — a name-only isArray('prop') would also turn the top-level
// <D:prop> request container into an array, and the `Object.keys(root.prop)` idiom that reads the requested
// prop names (caldav/xml-parser.ts:82-83) would then come back empty, silently zeroing wantsData/partialProps.
const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    removeNSPrefix: true,
    isArray: (name, jpath) =>
        name === 'href' || (name === 'prop' && typeof jpath === 'string' && jpath.endsWith('address-data.prop')),
});

export type CardReportRequest =
    | { type: 'addressbook-multiget'; hrefs: string[]; wantsData: boolean; partialProps: string[] | null }
    | {
          type: 'addressbook-query';
          filterRaw: unknown;
          limit: number | null;
          wantsData: boolean;
          partialProps: string[] | null;
      }
    | { type: 'sync-collection'; syncToken: string | undefined; wantsData: boolean };

// The requested <D:prop> container: whether address-data was asked for at all, and the CARD:prop name list
// under it (the partial-retrieval subset) when present. Full retrieval — <CARD:address-data/> with no
// children — leaves partialProps null; Task 18 wires the projection, Task 16 always serves full bytes.
function readProps(root: Record<string, unknown>): { wantsData: boolean; partialProps: string[] | null } {
    const prop = (root['prop'] ?? {}) as Record<string, unknown>;
    const wantsData = Object.keys(prop).some((k) => k.includes('address-data'));
    const addressData = prop['address-data'];
    let partialProps: string[] | null = null;
    if (addressData && typeof addressData === 'object') {
        const list = (addressData as Record<string, unknown>)['prop'];
        if (Array.isArray(list)) {
            const names = list
                .map((p) => (p as Record<string, unknown>)['@_name'])
                .filter((n): n is string => typeof n === 'string');
            if (names.length) partialProps = names;
        }
    }
    return { wantsData, partialProps };
}

// Parse a CardDAV REPORT body into one of the three request shapes. An unrecognised root or unparseable XML
// throws so the handler answers 400 (the caldav report.ts:25-29 contract).
export function parseCardReport(xml: string): CardReportRequest {
    const parsed = parser.parse(xml);

    const multiget = parsed['addressbook-multiget'] ?? parsed['CARD:addressbook-multiget'];
    const query = parsed['addressbook-query'] ?? parsed['CARD:addressbook-query'];
    const sync = parsed['sync-collection'] ?? parsed['D:sync-collection'];

    if (multiget) {
        const { wantsData, partialProps } = readProps(multiget);
        const hrefs: string[] = (multiget.href ?? []).map(String);
        return { type: 'addressbook-multiget', hrefs, wantsData, partialProps };
    }
    if (query) {
        const { wantsData, partialProps } = readProps(query);
        const nresults = query.limit?.nresults;
        const limit = nresults != null && Number.isFinite(Number(nresults)) ? Number(nresults) : null;
        return { type: 'addressbook-query', filterRaw: query.filter ?? null, limit, wantsData, partialProps };
    }
    if (sync) {
        const { wantsData } = readProps(sync);
        const token = sync['sync-token'];
        // An empty <D:sync-token/> parses to '' — the initial-full-sync signal (caldav/xml-parser.ts:79).
        return { type: 'sync-collection', syncToken: token ? String(token) : undefined, wantsData };
    }

    throw new Error('Unsupported REPORT type');
}
