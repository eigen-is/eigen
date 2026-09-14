import { escapeXml } from '@workspace/lib/html';
import { XMLParser } from 'fast-xml-parser';
import { propstatNotFound, propstatOk } from './xml';
import { asNode, isXmlNode, type XmlNode } from './xml-node';

// The shared PROPFIND core both DAV surfaces sit on (RFC 4918 § 9.1): parse the request body into the
// requested prop list, then select per-row propstats from an ordered name→fragment map. One implementation so
// CalDAV and CardDAV can't drift.

// One ceiling for every XML request body both DAV surfaces read (PROPFIND, REPORT, MKCALENDAR, PROPPATCH):
// each is a small prop list or href list, bounded before it reaches a parser.
export const DAV_BODY_MAX_BYTES = 1_048_576;

// Element local name → XML fragment, in emission order; allprop and the selector share it, so no list can drift.
export type PropMap = Map<string, string>;

// One requested property. `name` is the local name (prefix stripped) used to match PropMap keys — the same
// local-name idiom both REPORT parsers use. `prefix`/`ns` are kept only to echo an unknown prop back in its
// declared namespace inside the 404 propstat.
type RequestedProp = {
    name: string;
    prefix: string;
    ns: string | null;
};

export type PropfindRequest = { allprop: true } | { allprop: false; props: RequestedProp[] };

// removeNSPrefix is deliberately OFF (unlike the REPORT parsers): the 404 echo must reproduce each unknown
// prop's namespace, and the prefix is the only handle on it. Attributes are kept so xmlns declarations survive.
const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_', parseTagValue: false });

const localName = (key: string): string => (key.includes(':') ? key.slice(key.indexOf(':') + 1) : key);
const prefixOf = (key: string): string => (key.includes(':') ? key.slice(0, key.indexOf(':')) : '');
const isElementKey = (key: string): boolean => !key.startsWith('@_') && key !== '#text';

function findChild(obj: XmlNode, local: string): unknown {
    for (const key of Object.keys(obj)) {
        if (key !== '?xml' && isElementKey(key) && localName(key) === local) return obj[key];
    }
    return undefined;
}

// xmlns declarations reachable from the given nodes: default namespace plus prefix→uri. Real clients declare at
// the document root, so we merge the root, the <prop> node, and the prop element itself — enough coverage
// without full namespace-scoping machinery.
function collectNamespaces(nodes: unknown[]): { def: string | null; byPrefix: Map<string, string> } {
    const byPrefix = new Map<string, string>();
    let def: string | null = null;
    for (const node of nodes) {
        if (!isXmlNode(node)) continue;
        for (const [k, v] of Object.entries(node)) {
            if (k === '@_xmlns') def = String(v);
            else if (k.startsWith('@_xmlns:')) byPrefix.set(k.slice('@_xmlns:'.length), String(v));
        }
    }
    return { def, byPrefix };
}

export function parsePropfind(xml: string): PropfindRequest {
    const body = xml.trim();
    // Absent/empty body → allprop (the compat path every bodyless PROPFIND test rides).
    if (body === '') return { allprop: true };

    let parsed: XmlNode;
    try {
        parsed = asNode(parser.parse(body));
    } catch {
        return { allprop: true };
    }

    const root = findChild(parsed, 'propfind');
    if (!isXmlNode(root)) return { allprop: true };

    const propNode = findChild(root, 'prop');
    // <allprop/> and <propname/> both land here as "no <prop>" → allprop. Treating <propname/> as allprop is a
    // lenient v1: we serve the values, not the names-only variant.
    if (!isXmlNode(propNode)) return { allprop: true };

    const ns = collectNamespaces([root, propNode]);
    const props: RequestedProp[] = [];
    for (const key of Object.keys(propNode)) {
        if (!isElementKey(key)) continue;
        const prefix = prefixOf(key);
        const own = collectNamespaces([propNode[key]]);
        const uri = prefix === '' ? (own.def ?? ns.def) : (own.byPrefix.get(prefix) ?? ns.byPrefix.get(prefix) ?? null);
        props.push({ name: localName(key), prefix, ns: uri });
    }
    return { allprop: false, props };
}

// RFC 4918 Brief:t and RFC 8144 Prefer:return=minimal both mean "drop the 404 propstat".
export function wantsBrief(request: Request): boolean {
    if (request.headers.get('Brief')?.trim().toLowerCase() === 't') return true;
    return /(^|[\s,])return=minimal([\s,;]|$)/i.test(request.headers.get('Prefer') ?? '');
}

// fxp accepts tag names XML forbids (`<`, `&`), which would make the echoed element non-well-formed. Letters,
// digits and marks in any script are XML NameChars; the rarer punctuation NameChars are left out.
const NCNAME_ISH = /^[\p{L}_][\p{L}\p{N}\p{M}._-]*$/u;
export function isNcName(name: string): boolean {
    return NCNAME_ISH.test(name);
}

// An unknown prop echoed inside the 404 propstat, self-declaring its namespace (<x:name xmlns:x="uri"/>). A
// default-namespace prop needs a synthetic prefix to be self-declared; an unresolvable namespace or a
// non-NCName name/prefix is dropped (degrading to today's silence for that one prop).
function echoMissing(p: RequestedProp): string | null {
    if (p.ns === null || !isNcName(p.name) || (p.prefix !== '' && !isNcName(p.prefix))) return null;
    const prefix = p.prefix || 'x';
    return `<${prefix}:${p.name} xmlns:${prefix}="${escapeXml(p.ns)}"/>`;
}

// The propstat blocks for one row: allprop emits every available fragment; a named request emits a 200 propstat
// with the props we have and (unless brief) a 404 propstat naming the ones we don't.
export function selectProps(available: PropMap, request: PropfindRequest, brief: boolean): string[] {
    if (request.allprop) return [propstatOk([...available.values()])];

    const found: string[] = [];
    const missing: string[] = [];
    for (const p of request.props) {
        const fragment = available.get(p.name);
        if (fragment !== undefined) found.push(fragment);
        else {
            const echo = echoMissing(p);
            if (echo) missing.push(echo);
        }
    }

    const propstats = [propstatOk(found)];
    if (missing.length > 0 && !brief) propstats.push(propstatNotFound(missing));
    return propstats;
}
