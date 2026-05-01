import { type DrivePath, isContainerType } from '@workspace/lib/types/drive';
import { XMLParser, XMLValidator } from 'fast-xml-parser';
import { getMountQuotaState } from '../config/enforcement';
import { ApiError } from '../core/errors';
import { getSharedDrive } from '../drive/get-drive';
import type { User } from '../user';
import { isHiddenName } from './container-overlay';
import { buildXmlResponse, encodeHref, escapeXml, multistatus, propstatOk, resourceProps, response } from './xml';

const FINITE_DEPTH_BODY = `<?xml version="1.0" encoding="utf-8"?>
<D:error xmlns:D="DAV:"><D:propfind-finite-depth/></D:error>`;

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
    const parsed = propfindParser.parse(trimmed) as Record<string, unknown>;
    if (!('propfind' in parsed)) {
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
        return new Response(FINITE_DEPTH_BODY, {
            status: 403,
            headers: { 'Content-Type': 'application/xml; charset=utf-8' },
        });
    }

    const drive = await getSharedDrive(ownerId, user);
    const path = await drive.resolvePath(mountId, pathStr);
    if (!path) throw new ApiError(404, 'Not found');

    const baseHref = `/webdav/${encodeHref(ownerId)}/${encodeHref(mountId)}`;
    const isCollection = isContainerType(path.type);
    const responses: string[] = [];

    if (isCollection) {
        const { used, max } = await getMountQuotaState(ownerId, user.id, mountId);
        responses.push(
            response(`${baseHref}${withTrailingSlash(encodeHref(pathStr))}`, [
                propstatOk([
                    ...resourceProps({
                        path,
                        isCollection: true,
                        quotaUsed: used,
                        quotaAvailable: Math.max(0, max - used),
                        locks: drive.lockManager.listForPath(path.id),
                    }),
                    ...deadPropsXml(path),
                ]),
            ]),
        );
    } else {
        responses.push(
            response(`${baseHref}${encodeHref(pathStr)}`, [
                propstatOk([
                    ...resourceProps({
                        path,
                        isCollection: false,
                        locks: drive.lockManager.listForPath(path.id),
                    }),
                    ...deadPropsXml(path),
                ]),
            ]),
        );
    }

    if (isCollection && depth === '1') {
        const children = await drive.getFolderContents(mountId, path.id);
        const parentHref = withTrailingSlash(pathStr);
        for (const child of children) {
            if (isHiddenName(child.name)) continue;
            const childIsCollection = isContainerType(child.type);
            const childPath = `${parentHref}${child.name}${childIsCollection ? '/' : ''}`;
            responses.push(
                response(`${baseHref}${encodeHref(childPath)}`, [
                    propstatOk([
                        ...resourceProps({
                            path: child,
                            isCollection: childIsCollection,
                            locks: drive.lockManager.listForPath(child.id),
                        }),
                        ...deadPropsXml(child),
                    ]),
                ]),
            );
        }
    }

    return buildXmlResponse(multistatus(responses));
}
