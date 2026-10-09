import { escapeXml } from '@workspace/lib/xml';
import { ApiError } from '../core/errors';
import { parseXmlRoot, type XmlElement, xmlChild, xmlElements } from '../core/xml';
import { DAV_NAMESPACES, propstatNotFound, propstatOk } from './xml';

// The shared PROPFIND core (RFC 4918 § 9.1): CalDAV and CardDAV parse the request body into the requested prop
// list and select per-row propstats from an ordered name→fragment map; WebDAV only checks the body.

const DAV = DAV_NAMESPACES.D;

// XML fragment by the name it is written with (`D:getetag`), in emission order; allprop and the selector share it,
// so no list can drift. Each DAV_NAMESPACES prefix stands for one namespace, so the key is namespace and local name.
export type PropMap = Map<string, string>;

const PREFIXES = new Map<string, string>(Object.entries(DAV_NAMESPACES).map(([prefix, uri]) => [uri, prefix]));

// Every unknown prop is echoed in every row, so the list a request may name is bounded.
const MAX_PROPFIND_PROPS = 1000;
// Each echoed prop repeats its namespace, so one long URI declared once would be written a thousand times per row.
const MAX_PROPFIND_ECHO_LENGTH = 64 * 1024;

// `notFound` holds the 404 propstat per set of found props, so rows of one shape share one string.
export type PropfindRequest =
    | { allprop: true }
    | { allprop: false; props: XmlElement[]; notFound: Map<string, string> };

// A blank body is allprop; any other must be a DAV:propfind.
export function parsePropfind(body: Uint8Array): PropfindRequest {
    const root = parseXmlRoot(body, DAV, 'propfind');
    if (!root) return { allprop: true };

    const prop = xmlChild(root, DAV, 'prop');
    // <allprop/> and <propname/> both land here as "no <prop>" → allprop. Treating <propname/> as allprop is a
    // lenient v1: we serve the values, not the names-only variant.
    if (!prop) return { allprop: true };
    const props = new Map<string, XmlElement>();
    let echoLength = 0;
    for (const element of xmlElements(prop)) {
        const key = `${element.local} ${element.ns}`;
        if (props.has(key)) continue;
        props.set(key, element);
        echoLength += echoMissing(element).length;
    }
    if (props.size > MAX_PROPFIND_PROPS) throw new ApiError(400, 'Too many props');
    if (echoLength > MAX_PROPFIND_ECHO_LENGTH) throw new ApiError(400, 'Prop names too long');
    return { allprop: false, props: [...props.values()], notFound: new Map() };
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
    const foundAt: number[] = [];
    for (const [index, prop] of request.props.entries()) {
        const prefix = PREFIXES.get(prop.ns);
        const fragment = prefix === undefined ? undefined : available.get(`${prefix}:${prop.local}`);
        if (fragment === undefined) continue;
        found.push(fragment);
        foundAt.push(index);
    }

    const propstats = [propstatOk(found)];
    if (found.length === request.props.length || brief) return propstats;
    const key = foundAt.join(',');
    let notFound = request.notFound.get(key);
    if (notFound === undefined) {
        const served = new Set(foundAt);
        notFound = propstatNotFound(request.props.filter((_, index) => !served.has(index)).map(echoMissing));
        request.notFound.set(key, notFound);
    }
    propstats.push(notFound);
    return propstats;
}
