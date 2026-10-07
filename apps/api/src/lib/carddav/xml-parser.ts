import { ApiError } from '../core/errors';
import {
    parseXml,
    type XmlElement,
    xmlAttr,
    xmlChild,
    xmlChildren,
    xmlElements,
    xmlText,
    xmlTrimmedText,
} from '../core/xml';
import { readHrefs, readSyncToken, UnsupportedFilterError } from '../dav/report-request';
import { DAV_NAMESPACES } from '../dav/xml';
import {
    assertSupportedCollation,
    type ParamFilter,
    type PropFilter,
    type QueryFilter,
    type TextMatch,
} from './query-filter';

const DAV = DAV_NAMESPACES.D;
const CARDDAV = DAV_NAMESPACES.CARD;

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
// children — leaves partialProps null, which is the handler's "serve the stored bytes whole" signal.
function readProps(root: XmlElement): { wantsData: boolean; partialProps: string[] | null } {
    const prop = xmlChild(root, DAV, 'prop');
    const addressData = prop && xmlChild(prop, CARDDAV, 'address-data');
    const names = addressData
        ? xmlChildren(addressData, CARDDAV, 'prop')
              .map((p) => xmlAttr(p, '', 'name'))
              .filter((n) => n !== undefined)
        : [];
    return { wantsData: addressData !== undefined, partialProps: names.length ? names : null };
}

// Anything outside the grammar's allow-set is a filter the parser can't map → UnsupportedFilterError (403 supported-filter).
function assertOnlyChildren(node: XmlElement, allowed: Set<string>): void {
    for (const child of xmlElements(node)) {
        if (child.ns !== CARDDAV || !allowed.has(child.local)) throw new UnsupportedFilterError(child.local);
    }
}

const MATCH_TYPES = new Set<string>(['equals', 'contains', 'starts-with', 'ends-with']);
const isMatchType = (v: string): v is TextMatch['matchType'] => MATCH_TYPES.has(v);
const FILTER_CHILDREN = new Set(['prop-filter']);
const PROP_FILTER_CHILDREN = new Set(['is-not-defined', 'text-match', 'param-filter']);
const PARAM_FILTER_CHILDREN = new Set(['is-not-defined', 'text-match']);

// <text-match collation="…" match-type="…" negate-condition="yes">value</text-match>. With no attributes the
// § 10.5.4 defaults apply: collation i;unicode-casemap, match-type contains. The collation is validated here so
// an unsupported one is a book-independent 403.
function parseTextMatch(node: XmlElement): TextMatch {
    assertOnlyChildren(node, new Set());
    const collation = xmlAttr(node, '', 'collation') ?? null;
    assertSupportedCollation(collation);
    const matchTypeAttr = xmlAttr(node, '', 'match-type');
    const matchType = matchTypeAttr !== undefined && isMatchType(matchTypeAttr) ? matchTypeAttr : 'contains';
    return {
        collation,
        matchType,
        negate: xmlAttr(node, '', 'negate-condition') === 'yes',
        value: xmlTrimmedText(node),
    };
}

function parseParamFilter(node: XmlElement): ParamFilter {
    assertOnlyChildren(node, PARAM_FILTER_CHILDREN);
    const isNotDefined = xmlChild(node, CARDDAV, 'is-not-defined') !== undefined;
    const textMatch = xmlChild(node, CARDDAV, 'text-match');
    return {
        name: (xmlAttr(node, '', 'name') ?? '').toUpperCase(),
        isNotDefined,
        textMatch: isNotDefined || !textMatch ? null : parseTextMatch(textMatch),
    };
}

function parsePropFilter(node: XmlElement): PropFilter {
    assertOnlyChildren(node, PROP_FILTER_CHILDREN);
    const isNotDefined = xmlChild(node, CARDDAV, 'is-not-defined') !== undefined;
    return {
        name: (xmlAttr(node, '', 'name') ?? '').toUpperCase(),
        test: xmlAttr(node, '', 'test') === 'allof' ? 'allof' : 'anyof',
        isNotDefined,
        // is-not-defined and text-match/param-filter are mutually exclusive (§ 10.5.1); is-not-defined wins.
        textMatches: isNotDefined ? [] : xmlChildren(node, CARDDAV, 'text-match').map(parseTextMatch),
        paramFilters: isNotDefined ? [] : xmlChildren(node, CARDDAV, 'param-filter').map(parseParamFilter),
    };
}

function parseFilter(node: XmlElement): QueryFilter {
    assertOnlyChildren(node, FILTER_CHILDREN);
    return {
        test: xmlAttr(node, '', 'test') === 'allof' ? 'allof' : 'anyof',
        propFilters: xmlChildren(node, CARDDAV, 'prop-filter').map(parsePropFilter),
    };
}

// Parse a CardDAV REPORT body into one of the three request shapes. A blank body, an unrecognised root or
// unparseable XML is a 400, as in CalDAV. An addressbook-query filter that names an unsupported collation or an
// unmappable element throws the two typed errors, which the handler maps to their 403 preconditions.
export function parseCardReport(body: Uint8Array): CardReportRequest {
    const root = parseXml(body);
    if (!root) throw new ApiError(400, 'Empty REPORT');

    if (root.ns === CARDDAV && root.local === 'addressbook-multiget') {
        const { wantsData, partialProps } = readProps(root);
        return { type: 'addressbook-multiget', hrefs: readHrefs(root), wantsData, partialProps };
    }
    if (root.ns === CARDDAV && root.local === 'addressbook-query') {
        const { wantsData, partialProps } = readProps(root);
        // xs:unsignedLong — ignore a non-numeric/negative limit; floor a fractional one.
        const limitNode = xmlChild(root, CARDDAV, 'limit');
        const nresultsNode = limitNode && xmlChild(limitNode, CARDDAV, 'nresults');
        const nresults = nresultsNode ? Number(xmlText(nresultsNode)) : Number.NaN;
        const limit = Number.isFinite(nresults) && nresults >= 0 ? Math.floor(nresults) : null;
        // RFC 6352 § 8.6 requires a CARDDAV:filter; a body without one parses to null and the handler 400s.
        const filterNode = xmlChild(root, CARDDAV, 'filter');
        const filter = filterNode ? parseFilter(filterNode) : null;
        return { type: 'addressbook-query', filter, limit, wantsData, partialProps };
    }
    if (root.ns === DAV && root.local === 'sync-collection') {
        const { wantsData } = readProps(root);
        return { type: 'sync-collection', syncToken: readSyncToken(root), wantsData };
    }
    throw new ApiError(400, 'Unsupported REPORT type');
}
