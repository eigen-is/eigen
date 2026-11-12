// The WebDAV PROPFIND method: a file or folder's properties, and with Depth 1 those of a folder's children,
// as one multistatus. The WebDAV router calls it with the signed-in user, through getSharedDrive, so a path
// the user can't read answers as missing. Every row carries the same live properties, its locks and the
// client's own stored properties; the requested folder also carries the mount's quota.

import type { DrivePath } from '@workspace/lib/types/drive';
import { isContainerType } from '@workspace/lib/types/drive';
import { escapeXml } from '@workspace/lib/xml';
import { getMountQuotaState } from '../config/enforcement';
import { ApiError } from '../core/errors';
import { XML_NAMESPACE } from '../core/xml';
import { parsePropfind } from '../dav/propfind';
import { DAV_NAMESPACES, davError } from '../dav/xml';
import { getSharedDrive } from '../drive/get-drive';
import type { User } from '../user';
import { isHiddenName } from './container-overlay';
import { encodeHref, mountHref } from './path';
import { buildXmlResponse, multistatus, propstatStatus, resourceProps, response } from './xml';

export async function handleResourcePropfind(args: {
    user: User;
    ownerId: string;
    mountId: string;
    pathStr: string;
    depth: '0' | '1' | 'infinity';
    body: Uint8Array;
}): Promise<Response> {
    const { user, ownerId, mountId, pathStr, depth, body } = args;

    // Checked, not read (RFC 4918 §9.1, a bad body is a 400): every row carries the same props whatever it names.
    parsePropfind(body);

    if (depth === 'infinity') {
        return davError(403, '<D:propfind-finite-depth/>');
    }

    const drive = await getSharedDrive(ownerId, user);
    const path = await drive.resolvePath(mountId, pathStr);
    if (!path) throw new ApiError(404, 'Not found');

    const baseHref = mountHref(ownerId, mountId);
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
        const { used, max } = await getMountQuotaState(ownerId, mountId);
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
            const childPath = `${parentHref}${child.name}${isContainerType(child.type) ? '/' : ''}`;
            responses.push(rowResponse(`${baseHref}${encodeHref(childPath)}`, child));
        }
    }

    return buildXmlResponse(multistatus(responses));
}

function deadPropsXml(path: DrivePath): string[] {
    const deadProps = path.details?.webdavProps ?? [];
    return deadProps.map((dp) => {
        const safeName = escapeXml(dp.name);
        // Element content was serialized from the client's XML when it was set; text is escaped here.
        const safeValue = dp.xml ? dp.value : escapeXml(dp.value);
        if (dp.ns === DAV_NAMESPACES.D) return `<D:${safeName}>${safeValue}</D:${safeName}>`;
        // The xml prefix is bound already and its namespace may be declared on no other name.
        if (dp.ns === XML_NAMESPACE) return `<xml:${safeName}>${safeValue}</xml:${safeName}>`;
        // The prop's namespace is its default, so there is no prefix to pick. XML content declares its own bindings,
        // xmlns="" too.
        return `<${safeName} xmlns="${escapeXml(dp.ns)}">${safeValue}</${safeName}>`;
    });
}

function withTrailingSlash(p: string): string {
    return p.endsWith('/') ? p : `${p}/`;
}
