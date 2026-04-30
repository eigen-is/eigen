import { XMLParser } from 'fast-xml-parser';
import type { ProtocolUser } from '../auth/protocol-auth';
import { ApiError } from '../core/errors';
import { getWebdavDrive } from './get-drive';
import { buildXmlResponse, encodeHref, escapeXml, multistatus, propstatOk, propstatStatus, response } from './xml';

// RFC 4918 §15 classifies these as live properties: their values are derived from
// the resource itself (size, mtime, etag, locks, quota) or controlled by the
// server. PROPPATCH on a live property must return 403 Forbidden inside propstat
// rather than persisting an opaque copy that would shadow the real value.
const PROTECTED_PROPS = new Set([
    'displayname',
    'getcontentlength',
    'getcontenttype',
    'getlastmodified',
    'creationdate',
    'getetag',
    'resourcetype',
    'quota-used-bytes',
    'quota-available-bytes',
    'lockdiscovery',
    'supportedlock',
]);

// Keep namespace prefixes in tag names so we can distinguish DAV: from custom
// namespaces (Z:Win32CreationTime, etc.) — fast-xml-parser's removeNSPrefix
// would collapse them all into bare local names.
const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    removeNSPrefix: false,
    parseTagValue: false,
    trimValues: false,
});

type PropOp = { op: 'set' | 'remove'; namespace: string; name: string; value: string };

function stripPrefix(tag: string): { prefix: string; local: string } {
    const i = tag.indexOf(':');
    return i === -1 ? { prefix: '', local: tag } : { prefix: tag.slice(0, i), local: tag.slice(i + 1) };
}

// Resolve an element's namespace from its prefix using the xmlns declarations
// captured on the propertyupdate root and on the element itself. Bare elements
// fall back to the document's default xmlns or DAV: (the implicit default for
// PROPPATCH bodies served by Finder/curl/cadaver).
function resolveNamespace(prefix: string, attrs: Record<string, string>, defaultDav: string): string {
    if (!prefix) return attrs['@_xmlns'] ?? defaultDav;
    const declared = attrs[`@_xmlns:${prefix}`];
    if (declared) return declared;
    if (prefix === 'D') return 'DAV:';
    return '';
}

function* iterPropChildren(
    propBlock: unknown,
): IterableIterator<{ tag: string; value: string; attrs: Record<string, string> }> {
    if (!propBlock || typeof propBlock !== 'object') return;
    for (const [tag, raw] of Object.entries(propBlock)) {
        if (tag.startsWith('@_') || tag === '#text') continue;
        const entries = Array.isArray(raw) ? raw : [raw];
        for (const entry of entries) {
            if (entry === null || entry === undefined) {
                yield { tag, value: '', attrs: {} };
                continue;
            }
            if (typeof entry !== 'object') {
                yield { tag, value: String(entry), attrs: {} };
                continue;
            }
            const obj = entry as Record<string, unknown>;
            const attrs: Record<string, string> = {};
            for (const [k, v] of Object.entries(obj)) {
                if (k.startsWith('@_')) attrs[k] = String(v);
            }
            const value = '#text' in obj ? String(obj['#text']) : '';
            yield { tag, value, attrs };
        }
    }
}

export function extractPropOps(body: string): PropOp[] {
    if (!body?.trim()) return [];
    const parsed = parser.parse(body) as Record<string, unknown>;
    const rootKey = Object.keys(parsed).find((k) => stripPrefix(k).local === 'propertyupdate');
    if (!rootKey) return [];
    const root = parsed[rootKey] as Record<string, unknown>;

    const docAttrs: Record<string, string> = {};
    for (const [k, v] of Object.entries(root)) {
        if (k.startsWith('@_')) docAttrs[k] = String(v);
    }

    const ops: PropOp[] = [];
    for (const verb of ['set', 'remove'] as const) {
        for (const [k, raw] of Object.entries(root)) {
            if (stripPrefix(k).local !== verb) continue;
            const entries = Array.isArray(raw) ? raw : [raw];
            for (const entry of entries) {
                if (!entry || typeof entry !== 'object') continue;
                const propKey = Object.keys(entry).find((pk) => stripPrefix(pk).local === 'prop');
                if (!propKey) continue;
                for (const child of iterPropChildren((entry as Record<string, unknown>)[propKey])) {
                    const { prefix, local } = stripPrefix(child.tag);
                    const namespace = resolveNamespace(prefix, { ...docAttrs, ...child.attrs }, 'DAV:');
                    ops.push({ op: verb, namespace, name: local, value: child.value });
                }
            }
        }
    }
    return ops;
}

function renderPropElement(op: PropOp): string {
    const safe = escapeXml(op.name);
    if (op.namespace === 'DAV:') return `<D:${safe}/>`;
    return `<X:${safe} xmlns:X="${escapeXml(op.namespace)}"/>`;
}

export async function handleProppatch(args: {
    user: ProtocolUser;
    ownerId: string;
    mountId: string;
    pathStr: string;
    body: string;
}): Promise<Response> {
    const { user, ownerId, mountId, pathStr, body } = args;
    const drive = await getWebdavDrive(ownerId, user);
    const path = await drive.resolvePath(mountId, pathStr);
    if (!path) throw new ApiError(404, 'Not found');

    const ops = extractPropOps(body);
    const propstats: string[] = [];
    for (const op of ops) {
        const propEl = renderPropElement(op);
        if (op.namespace === 'DAV:' && PROTECTED_PROPS.has(op.name)) {
            propstats.push(propstatStatus(403, 'Forbidden', [propEl]));
            continue;
        }
        if (op.op === 'set') {
            await drive.setDeadProp(mountId, path.id, op.namespace, op.name, op.value);
        } else {
            await drive.removeDeadProp(mountId, path.id, op.namespace, op.name);
        }
        propstats.push(propstatOk([propEl]));
    }

    const href = `/webdav/${encodeHref(ownerId)}/${encodeHref(mountId)}${encodeHref(pathStr)}`;
    return buildXmlResponse(multistatus([response(href, propstats)]));
}
