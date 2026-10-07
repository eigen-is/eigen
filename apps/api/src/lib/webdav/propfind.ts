import { type DrivePath, isContainerType } from '@workspace/lib/types/drive';
import { escapeXml } from '@workspace/lib/xml';
import { getMountQuotaState } from '../config/enforcement';
import { ApiError } from '../core/errors';
import { parsePropfind } from '../dav/propfind';
import { davError } from '../dav/xml';
import { getSharedDrive } from '../drive/get-drive';
import type { User } from '../user';
import { isHiddenName } from './container-overlay';
import { encodeHref } from './path';
import { buildXmlResponse, multistatus, propstatStatus, resourceProps, response } from './xml';

function withTrailingSlash(p: string): string {
    return p.endsWith('/') ? p : `${p}/`;
}

function deadPropsXml(path: DrivePath): string[] {
    const deadProps = path.details?.webdavProps ?? [];
    return deadProps.map((dp) => {
        const safeName = escapeXml(dp.name);
        // Element content was serialized from the client's XML when it was set; text is escaped here.
        const safeValue = dp.xml ? dp.value : escapeXml(dp.value);
        if (dp.ns === 'DAV:') return `<D:${safeName}>${safeValue}</D:${safeName}>`;
        // The prop's namespace is its default: no prefix to pick, and XML content declares its own bindings, xmlns="" too.
        return `<${safeName} xmlns="${escapeXml(dp.ns)}">${safeValue}</${safeName}>`;
    });
}

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
            const childIsCollection = isContainerType(child.type);
            const childPath = `${parentHref}${child.name}${childIsCollection ? '/' : ''}`;
            responses.push(rowResponse(`${baseHref}${encodeHref(childPath)}`, child));
        }
    }

    return buildXmlResponse(multistatus(responses));
}
