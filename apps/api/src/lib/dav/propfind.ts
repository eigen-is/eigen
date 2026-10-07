import { escapeXml } from '@workspace/lib/xml';
import { ApiError } from '../core/errors';
import { parseXml, type XmlElement, xmlChild, xmlElements } from '../core/xml';
import { DAV_NAMESPACES, propstatNotFound, propstatOk } from './xml';

// The shared PROPFIND core both DAV surfaces sit on (RFC 4918 § 9.1): parse the request body into the
// requested prop list, then select per-row propstats from an ordered name→fragment map. One implementation so
// CalDAV and CardDAV can't drift.

// One ceiling for every XML request body both DAV surfaces read (PROPFIND, REPORT, MKCALENDAR, PROPPATCH):
// each is a small prop list or href list, bounded before it reaches a parser.
export const DAV_BODY_MAX_BYTES = 1_048_576;

// XML fragment by the name it is written with (`D:getetag`), in emission order; allprop and the selector share it,
// so no list can drift. Each DAV_NAMESPACES prefix stands for one namespace, so the key is namespace and local name.
export type PropMap = Map<string, string>;

const PREFIXES = new Map<string, string>(Object.entries(DAV_NAMESPACES).map(([prefix, uri]) => [uri, prefix]));

export type PropfindRequest = { allprop: true } | { allprop: false; props: XmlElement[] };

// A blank body is allprop; any other must be a DAV:propfind.
export function parsePropfind(body: Uint8Array): PropfindRequest {
    const root = parseXml(body);
    if (!root) return { allprop: true };
    if (root.ns !== 'DAV:' || root.local !== 'propfind') throw new ApiError(400, 'Expected <propfind> root element');

    const prop = xmlChild(root, 'DAV:', 'prop');
    // <allprop/> and <propname/> both land here as "no <prop>" → allprop. Treating <propname/> as allprop is a
    // lenient v1: we serve the values, not the names-only variant.
    if (!prop) return { allprop: true };
    return { allprop: false, props: xmlElements(prop) };
}

// RFC 4918 Brief:t and RFC 8144 Prefer:return=minimal both mean "drop the 404 propstat".
export function wantsBrief(request: Request): boolean {
    if (request.headers.get('Brief')?.trim().toLowerCase() === 't') return true;
    return /(^|[\s,])return=minimal([\s,;]|$)/i.test(request.headers.get('Prefer') ?? '');
}

// An unknown prop echoed inside the 404 propstat by the name it was asked with, declaring its own namespace.
function echoMissing(prop: XmlElement): string {
    const colon = prop.name.indexOf(':');
    const declaration = colon < 0 ? 'xmlns' : `xmlns:${prop.name.slice(0, colon)}`;
    return `<${prop.name} ${declaration}="${escapeXml(prop.ns)}"/>`;
}

// The propstat blocks for one row: allprop emits every available fragment; a named request emits a 200 propstat
// with the props we have and (unless brief) a 404 propstat naming the ones we don't.
export function selectProps(available: PropMap, request: PropfindRequest, brief: boolean): string[] {
    if (request.allprop) return [propstatOk([...available.values()])];

    const found: string[] = [];
    const missing: string[] = [];
    for (const prop of request.props) {
        const prefix = PREFIXES.get(prop.ns);
        const fragment = prefix === undefined ? undefined : available.get(`${prefix}:${prop.local}`);
        if (fragment !== undefined) found.push(fragment);
        else missing.push(echoMissing(prop));
    }

    const propstats = [propstatOk(found)];
    if (missing.length > 0 && !brief) propstats.push(propstatNotFound(missing));
    return propstats;
}
