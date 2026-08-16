// The addressbook-query filter engine (RFC 6352 § 8.6 / § 10.5). Matching runs in-memory over a card's
// content-line AST — books are small and queries rare, so this stays off every hot path (spec § 4 /
// § Performance). The parser (xml-parser.ts) builds a QueryFilter from the REPORT body; matchCard evaluates
// one card against it. Partial address-data (a requested property subset) is a separate concern.
import { unescapeText, type VCardLine } from './vcard-ast';

export type TextMatch = {
    collation: string | null;
    matchType: 'equals' | 'contains' | 'starts-with' | 'ends-with';
    negate: boolean;
    value: string;
};
export type ParamFilter = { name: string; isNotDefined: boolean; textMatch: TextMatch | null };
export type PropFilter = {
    name: string;
    test: 'anyof' | 'allof';
    isNotDefined: boolean;
    textMatches: TextMatch[];
    paramFilters: ParamFilter[];
};
export type QueryFilter = { test: 'anyof' | 'allof'; propFilters: PropFilter[] };

// A query naming a collation Eigen doesn't implement. RFC 6352 § 8.3 requires only the two case-map
// collations; anything else is answered 403 with CARD:supported-collation, never silently downgraded.
export class UnsupportedCollationError extends Error {}
// A filter whose structure the parser can't map to the types above — an unknown child element, a construct
// beyond RFC 6352 § 10.5. Answered 403 with CARD:supported-filter, never a full-set superset (spec § 4).
export class UnsupportedFilterError extends Error {}

// The one source of truth for which collations the server accepts (RFC 6352 § 8.3). i;unicode-casemap is the
// default when the attribute is absent (§ 10.5.4). The parser validates each text-match against this set up
// front — book-independent, so an unsupported collation is a 403 even against an empty book — and
// foldForCollation below trusts the result.
const SUPPORTED_COLLATIONS = new Set(['i;ascii-casemap', 'i;unicode-casemap']);

export function assertSupportedCollation(collation: string | null): void {
    if (collation !== null && !SUPPORTED_COLLATIONS.has(collation)) throw new UnsupportedCollationError(collation);
}

// Case-fold a value for comparison. i;ascii-casemap folds only ASCII A–Z, so accented letters keep their
// case; i;unicode-casemap (the default, i.e. anything the parser let through that isn't ascii-casemap) folds
// via toLowerCase().
function foldForCollation(value: string, collation: string | null): string {
    return collation === 'i;ascii-casemap' ? value.replace(/[A-Z]/g, (c) => c.toLowerCase()) : value.toLowerCase();
}

// Does one value satisfy a single text-match (before negation)? Both sides are collation-folded.
function textValueMatches(value: string, tm: TextMatch): boolean {
    const hay = foldForCollation(value, tm.collation);
    const needle = foldForCollation(tm.value, tm.collation);
    switch (tm.matchType) {
        case 'equals':
            return hay === needle;
        case 'starts-with':
            return hay.startsWith(needle);
        case 'ends-with':
            return hay.endsWith(needle);
        default:
            return hay.includes(needle);
    }
}

// A text-match over every instance of the property (§ 10.5.4): it matches when ANY instance's value matches;
// negate-condition="yes" flips that to "no instance matches". The caller passes the non-empty set of instances
// of the named property — the property-exists gate lives in the prop-filter (§ 10.5.1).
function textMatchSatisfied(lines: VCardLine[], tm: TextMatch): boolean {
    const anyMatch = lines.some((l) => textValueMatches(unescapeText(l.value), tm));
    return tm.negate ? !anyMatch : anyMatch;
}

// A param-filter over the property instances (§ 10.5.3): it matches when ANY instance carries the named
// parameter and the parameter either has no text-match (a presence test) or a value that satisfies it;
// is-not-defined inverts to "an instance lacks the parameter". Parameter values are compared as the AST stores
// them, so a `TYPE=CELL,VOICE` comma-list is the single value 'CELL,VOICE' (a `contains cell` matches it, an
// `equals cell` does not).
function paramFilterSatisfied(lines: VCardLine[], pf: ParamFilter): boolean {
    return lines.some((line) => {
        const values = line.params.filter(([n]) => n === pf.name).map(([, v]) => v);
        if (pf.isNotDefined) return values.length === 0;
        if (!pf.textMatch) return values.length > 0;
        const tm = pf.textMatch;
        return values.some((v) => textValueMatches(v, tm));
    });
}

// A prop-filter (§ 10.5.1): the named property must EXIST and its text-match/param-filter children pass per the
// prop-filter's test (an empty prop-filter is a bare existence test); OR is-not-defined and the property is
// absent. Names are group-insensitive (VCardLine.name already has any `item1.` group stripped) and matched
// case-insensitively — both sides are UPPERCASE.
function propFilterSatisfied(allLines: VCardLine[], pf: PropFilter): boolean {
    const lines = allLines.filter((l) => l.name === pf.name);
    if (pf.isNotDefined) return lines.length === 0;
    if (lines.length === 0) return false; // property absent and no is-not-defined → the prop-filter can't match
    if (pf.textMatches.length === 0 && pf.paramFilters.length === 0) return true; // bare existence
    const results = [
        ...pf.textMatches.map((tm) => textMatchSatisfied(lines, tm)),
        ...pf.paramFilters.map((p) => paramFilterSatisfied(lines, p)),
    ];
    return pf.test === 'allof' ? results.every(Boolean) : results.some(Boolean);
}

// Does a card (its content-line AST) satisfy the whole filter? anyof = any prop-filter matches, allof = all of
// them. An empty filter follows array semantics: anyof of nothing matches nothing, allof of nothing matches.
export function matchCard(lines: VCardLine[], filter: QueryFilter): boolean {
    const results = filter.propFilters.map((pf) => propFilterSatisfied(lines, pf));
    return filter.test === 'allof' ? results.every(Boolean) : results.some(Boolean);
}
