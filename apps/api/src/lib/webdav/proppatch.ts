import type { WebdavDeadProp } from '@workspace/lib/types/drive';
import { escapeXml } from '@workspace/lib/xml';
import { ApiError } from '../core/errors';
import { parseXml, serializeXmlChildren, XML_NAMESPACE, xmlChildren, xmlElements, xmlText } from '../core/xml';
import { getSharedDrive } from '../drive/get-drive';
import type { User } from '../user';
import { enclosingDocumentContainer } from './container-guard';
import { assertWritable } from './locks';
import { encodeHref } from './path';
import { buildXmlResponse, MAX_XML_BODY_BYTES, multistatus, propstatStatus, response } from './xml';

// RFC 4918 §15 classifies these as live properties: their values are derived from
// the resource itself (size, mtime, etag, locks, quota) or controlled by the
// server. PROPPATCH on a live property must return 403 Forbidden inside propstat
// rather than persisting an opaque copy that would shadow the real value. A set of the same name in no namespace
// is refused too, since a client reading names alone would take it for the live one; its remove runs, so a row
// stored before the refusal can go.
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

type PropOp = { op: 'set' | 'remove'; prop: WebdavDeadProp };

// RFC 4918 §9.2: set and remove run in document order, so a remove between two sets of one prop lands between them.
function extractPropOps(body: Uint8Array): PropOp[] {
    const root = parseXml(body);
    if (!root) return [];
    if (root.ns !== 'DAV:' || root.local !== 'propertyupdate') {
        throw new ApiError(400, 'Expected <propertyupdate> root element');
    }
    const ops: PropOp[] = [];
    for (const verb of xmlElements(root)) {
        if (verb.ns !== 'DAV:' || (verb.local !== 'set' && verb.local !== 'remove')) continue;
        for (const element of xmlChildren(verb, 'DAV:', 'prop').flatMap(xmlElements)) {
            const { ns, local: name } = element;
            // Element content stays XML; text is kept as written, whitespace included.
            const prop: WebdavDeadProp = xmlElements(element).length
                ? { ns, name, value: serializeXmlChildren(element), xml: true }
                : { ns, name, value: xmlText(element) };
            ops.push({ op: verb.local, prop });
        }
    }
    return ops;
}

export async function handleProppatch(args: {
    user: User;
    ownerId: string;
    mountId: string;
    pathStr: string;
    body: Uint8Array;
    ifHeader: string | null;
}): Promise<Response> {
    const { user, ownerId, mountId, pathStr, body, ifHeader } = args;
    const drive = await getSharedDrive(ownerId, user);
    const path = await drive.resolvePath(mountId, pathStr);
    if (!path) throw new ApiError(404, 'Not found');

    const breadcrumb = await drive.breadCrumb(mountId, path.id);
    if (enclosingDocumentContainer(breadcrumb, { includeSelf: false })) {
        throw new ApiError(423, 'Container internals are read-only');
    }
    assertWritable(drive.lockManager, breadcrumb, ifHeader, user.id);

    const ops = extractPropOps(body);
    // The xml namespace takes no other prefix (Namespaces in XML § 3), so a prop in it could be stored but never listed.
    const isProtected = ({ op, prop }: PropOp) =>
        prop.ns === XML_NAMESPACE ||
        (PROTECTED_PROPS.has(prop.name) && (prop.ns === 'DAV:' || (prop.ns === '' && op === 'set')));
    // RFC 4918 §9.2: all or nothing, so one refused op saves none and fails the rest with 424.
    const refused = ops.some(isProtected);

    // Apply all ops in memory first, then write once. RFC 4918 §9.2 requires
    // ops to be processed in document order; a set on an existing prop keeps
    // that prop's slot.
    if (!refused) {
        let webdavProps = path.details?.webdavProps ? [...path.details.webdavProps] : [];
        let mutated = false;
        for (const op of ops) {
            const idx = webdavProps.findIndex((p) => p.ns === op.prop.ns && p.name === op.prop.name);
            if (op.op === 'set') {
                if (idx === -1) webdavProps.push(op.prop);
                else webdavProps = webdavProps.map((p, i) => (i === idx ? op.prop : p));
                mutated = true;
            } else if (idx !== -1) {
                webdavProps = webdavProps.filter((_, i) => i !== idx);
                mutated = true;
            }
        }
        // Dead props live in the path row; one path stores no more than one PROPPATCH body can carry.
        if (Buffer.byteLength(JSON.stringify(webdavProps)) > MAX_XML_BODY_BYTES) {
            throw new ApiError(507, 'Insufficient Storage');
        }
        if (mutated) {
            await drive.updatePathDetails(mountId, path.id, {
                ...(path.details ?? {}),
                webdavProps: webdavProps.length === 0 ? undefined : webdavProps,
            });
        }
    }

    const propstats = ops.map((op) => {
        const safeName = escapeXml(op.prop.name);
        // A prop in no namespace can't take a prefix.
        const propEl =
            op.prop.ns === 'DAV:'
                ? `<D:${safeName}/>`
                : op.prop.ns === XML_NAMESPACE
                  ? `<xml:${safeName}/>`
                  : op.prop.ns === ''
                    ? `<${safeName} xmlns=""/>`
                    : `<X:${safeName} xmlns:X="${escapeXml(op.prop.ns)}"/>`;
        if (!refused) return propstatStatus(200, 'OK', [propEl]);
        return isProtected(op)
            ? propstatStatus(403, 'Forbidden', [propEl])
            : propstatStatus(424, 'Failed Dependency', [propEl]);
    });
    const href = `/webdav/${encodeHref(ownerId)}/${encodeHref(mountId)}${encodeHref(pathStr)}`;
    return buildXmlResponse(multistatus([response(href, propstats)]));
}
