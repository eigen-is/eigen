import { escapeXml } from '@workspace/lib/html';
import { type DrivePath, isContainerType } from '@workspace/lib/types/drive';
import { XMLParser, XMLValidator } from 'fast-xml-parser';
import { getMountQuotaState } from '../config/enforcement';
import { ApiError } from '../core/errors';
import { davError } from '../dav/xml';
import { asNode } from '../dav/xml-node';
import { getSharedDrive } from '../drive/get-drive';
import type { User } from '../user';
import { isHiddenName } from './container-overlay';
import { encodeHref } from './path';
import { buildXmlResponse, multistatus, propstatStatus, resourceProps, response } from './xml';

const propfindParser = new XMLParser({ ignoreAttributes: false, removeNSPrefix: true });

// RFC 4918 §9.1: empty body is allowed (= allprop). A non-empty body must be a
// well-formed XML document rooted at <propfind>. Anything else → 400.
function validatePropfindBody(body: string): void {
    const trimmed = body.trim();
    if (!trimmed) return;
    const validation = XMLValidator.validate(trimmed);
    if (validation !== true) {
        throw new ApiError(400, 'Malformed XML');
    }
    if (!('propfind' in asNode(propfindParser.parse(trimmed)))) {
        throw new ApiError(400, 'Expected <propfind> root element');
    }
}

function withTrailingSlash(p: string): string {
    return p.endsWith('/') ? p : `${p}/`;
}

function deadPropsXml(path: DrivePath): string[] {
    const deadProps = path.details?.webdavProps ?? [];
    return deadProps.map((dp) => {
        const safeName = escapeXml(dp.name);
        const safeValue = escapeXml(dp.value);
        if (dp.ns === 'DAV:') return `<D:${safeName}>${safeValue}</D:${safeName}>`;
        // Use a default-namespace declaration on the element rather than re-declaring a
        // shared prefix on every sibling. expat (used by neon-litmus) flags repeated
        // `xmlns:X="..."` declarations on adjacent siblings as "invalid namespace
        // declaration", even though the values match. xmlns="..." sidesteps the issue.
        return `<${safeName} xmlns="${escapeXml(dp.ns)}">${safeValue}</${safeName}>`;
    });
}

export async function handleResourcePropfind(args: {
    user: User;
    ownerId: string;
    mountId: string;
    pathStr: string;
    depth: '0' | '1' | 'infinity';
    body: string;
}): Promise<Response> {
    const { user, ownerId, mountId, pathStr, depth, body } = args;

    validatePropfindBody(body);

    if (depth === 'infinity') {
        return davError(403, '<D:propfind-finite-depth/>');
    }

    const drive = await getSharedDrive(ownerId, user);
    const path = await drive.resolvePath(mountId, pathStr);
    if (!path) throw new ApiError(404, 'Not found');

    const baseHref = `/webdav/${encodeHref(ownerId)}/${encodeHref(mountId)}`;
    const isCollection = isContainerType(path.type);

    const rowResponse = (href: string, rowPath: DrivePath, quotaUsed?: number, quotaAvailable?: number): string =>
        response(href, [
            propstatStatus(200, 'OK', [
                ...resourceProps({
                    path: rowPath,
                    isCollection: isContainerType(rowPath.type),
                    quotaUsed,
                    quotaAvailable,
                    locks: drive.lockManager.listForPath(rowPath.id),
                }),
                ...deadPropsXml(rowPath),
            ]),
        ]);

    const responses: string[] = [];

    if (isCollection) {
        const { used, max } = await getMountQuotaState(ownerId, user.id, mountId);
        responses.push(
            rowResponse(`${baseHref}${encodeHref(withTrailingSlash(pathStr))}`, path, used, Math.max(0, max - used)),
        );
    } else {
        responses.push(rowResponse(`${baseHref}${encodeHref(pathStr)}`, path));
    }

    if (isCollection && depth === '1') {
        const children = await drive.getFolderContents(mountId, path.id);
        const parentHref = withTrailingSlash(pathStr);
        for (const child of children) {
            if (isHiddenName(child.name)) continue;
            const childIsCollection = isContainerType(child.type);
            const childPath = `${parentHref}${child.name}${childIsCollection ? '/' : ''}`;
            responses.push(rowResponse(`${baseHref}${encodeHref(childPath)}`, child));
        }
    }

    return buildXmlResponse(multistatus(responses));
}
