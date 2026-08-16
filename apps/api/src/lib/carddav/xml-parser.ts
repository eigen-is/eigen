import { XMLParser } from 'fast-xml-parser';
import {
    assertSupportedCollation,
    type ParamFilter,
    type PropFilter,
    type QueryFilter,
    type TextMatch,
    UnsupportedFilterError,
} from './query-filter';

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
          filter: QueryFilter | null;
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

type XmlNode = Record<string, unknown>;

const asNode = (v: unknown): XmlNode => (v && typeof v === 'object' && !Array.isArray(v) ? (v as XmlNode) : {});
// fast-xml-parser collapses a single repeated child to the value itself; the filter grammar's `*`/`?` children
// are normalised to arrays here rather than via isArray so the config comment above stays about `href`/`prop`.
const asArray = (v: unknown): unknown[] => (v == null ? [] : Array.isArray(v) ? v : [v]);
const attr = (node: XmlNode, name: string): string | null => {
    const v = node[`@_${name}`];
    return v == null ? null : String(v);
};

// A node's element children are its keys minus attributes (`@_…`) and text (`#text`). Anything outside the
// grammar's allow-set is a filter the parser can't map → UnsupportedFilterError (403 supported-filter, § 4).
function assertOnlyChildren(node: XmlNode, allowed: Set<string>): void {
    for (const key of Object.keys(node)) {
        if (key.startsWith('@_') || key === '#text') continue;
        if (!allowed.has(key)) throw new UnsupportedFilterError(key);
    }
}

const MATCH_TYPES = new Set(['equals', 'contains', 'starts-with', 'ends-with']);
const FILTER_CHILDREN = new Set(['prop-filter']);
const PROP_FILTER_CHILDREN = new Set(['is-not-defined', 'text-match', 'param-filter']);
const PARAM_FILTER_CHILDREN = new Set(['is-not-defined', 'text-match']);

// <text-match collation="…" match-type="…" negate-condition="yes">value</text-match>. A bare
// `<text-match>value</text-match>` (no attributes) parses to the string value directly (§ 10.5.4 defaults:
// collation i;unicode-casemap, match-type contains). The collation is validated here so an unsupported one is
// a book-independent 403.
function parseTextMatch(raw: unknown): TextMatch {
    if (typeof raw !== 'object' || raw === null) {
        return { collation: null, matchType: 'contains', negate: false, value: raw == null ? '' : String(raw) };
    }
    const node = raw as XmlNode;
    assertOnlyChildren(node, new Set());
    const collation = attr(node, 'collation');
    assertSupportedCollation(collation);
    const matchTypeAttr = attr(node, 'match-type');
    const matchType = (
        matchTypeAttr && MATCH_TYPES.has(matchTypeAttr) ? matchTypeAttr : 'contains'
    ) as TextMatch['matchType'];
    const text = node['#text'];
    return {
        collation,
        matchType,
        negate: attr(node, 'negate-condition') === 'yes',
        value: text == null ? '' : String(text),
    };
}

function parseParamFilter(raw: unknown): ParamFilter {
    const node = asNode(raw);
    assertOnlyChildren(node, PARAM_FILTER_CHILDREN);
    const isNotDefined = 'is-not-defined' in node;
    const textMatches = asArray(node['text-match']);
    return {
        name: (attr(node, 'name') ?? '').toUpperCase(),
        isNotDefined,
        textMatch: isNotDefined || textMatches.length === 0 ? null : parseTextMatch(textMatches[0]),
    };
}

function parsePropFilter(raw: unknown): PropFilter {
    const node = asNode(raw);
    assertOnlyChildren(node, PROP_FILTER_CHILDREN);
    const isNotDefined = 'is-not-defined' in node;
    return {
        name: (attr(node, 'name') ?? '').toUpperCase(),
        test: attr(node, 'test') === 'allof' ? 'allof' : 'anyof',
        isNotDefined,
        // is-not-defined and text-match/param-filter are mutually exclusive (§ 10.5.1); is-not-defined wins.
        textMatches: isNotDefined ? [] : asArray(node['text-match']).map(parseTextMatch),
        paramFilters: isNotDefined ? [] : asArray(node['param-filter']).map(parseParamFilter),
    };
}

function parseFilter(raw: unknown): QueryFilter {
    const node = asNode(raw);
    assertOnlyChildren(node, FILTER_CHILDREN);
    return {
        test: attr(node, 'test') === 'allof' ? 'allof' : 'anyof',
        propFilters: asArray(node['prop-filter']).map(parsePropFilter),
    };
}

// Parse a CardDAV REPORT body into one of the three request shapes. An unrecognised root or unparseable XML
// throws so the handler answers 400 (the caldav report.ts:25-29 contract). An addressbook-query filter that
// names an unsupported collation or an unmappable element throws the two typed errors above, which the handler
// maps to their 403 preconditions.
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
        // RFC 6352 § 8.6 requires a CARDDAV:filter; a body without one parses to null and the handler 400s.
        const filter = query.filter == null ? null : parseFilter(query.filter);
        return { type: 'addressbook-query', filter, limit, wantsData, partialProps };
    }
    if (sync) {
        const { wantsData } = readProps(sync);
        const token = sync['sync-token'];
        // An empty <D:sync-token/> parses to '' — the initial-full-sync signal (caldav/xml-parser.ts:79).
        return { type: 'sync-collection', syncToken: token ? String(token) : undefined, wantsData };
    }

    throw new Error('Unsupported REPORT type');
}
