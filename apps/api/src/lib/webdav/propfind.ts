import { isContainerType } from '@workspace/lib/types';
import type { ProtocolUser } from '../auth/protocol-auth';
import { ApiError } from '../core/errors';
import type Drive from '../drive/drive';
import type SharedDrive from '../drive/sharedDrive';
import { getWebdavDrive } from './get-drive';
import { lockManager } from './locks';
import { WebdavPathCache } from './path-resolve';
import { buildXmlResponse, encodeHref, escapeXml, multistatus, propstatOk, resourceProps, response } from './xml';

const FINITE_DEPTH_BODY = `<?xml version="1.0" encoding="utf-8"?>
<D:error xmlns:D="DAV:"><D:propfind-finite-depth/></D:error>`;

function withTrailingSlash(p: string): string {
    return p.endsWith('/') ? p : `${p}/`;
}

async function deadPropsXml(drive: Drive | SharedDrive, mountId: string, pathId: string): Promise<string[]> {
    const deadProps = await drive.listDeadProps(mountId, pathId);
    return deadProps.map((dp) => {
        const safeName = escapeXml(dp.name);
        const safeValue = escapeXml(dp.value);
        if (dp.namespace === 'DAV:') return `<D:${safeName}>${safeValue}</D:${safeName}>`;
        return `<X:${safeName} xmlns:X="${escapeXml(dp.namespace)}">${safeValue}</X:${safeName}>`;
    });
}

export async function handleResourcePropfind(args: {
    user: ProtocolUser;
    ownerId: string;
    mountId: string;
    pathStr: string;
    depth: '0' | '1' | 'infinity';
}): Promise<Response> {
    const { user, ownerId, mountId, pathStr, depth } = args;

    if (depth === 'infinity') {
        return new Response(FINITE_DEPTH_BODY, {
            status: 403,
            headers: { 'Content-Type': 'application/xml; charset=utf-8' },
        });
    }

    const drive = await getWebdavDrive(ownerId, user);
    const cache = new WebdavPathCache();
    const path = await cache.resolve(drive, mountId, pathStr);
    if (!path) throw new ApiError(404, 'Not found');

    const baseHref = `/webdav/${encodeHref(ownerId)}/${encodeHref(mountId)}`;
    const isCollection = isContainerType(path.type);
    const responses: string[] = [];

    if (isCollection) {
        const [used, total, deadXml] = await Promise.all([
            drive.usedBytes(mountId),
            drive.quotaBytes(mountId),
            deadPropsXml(drive, mountId, path.id),
        ]);
        responses.push(
            response(`${baseHref}${withTrailingSlash(encodeHref(pathStr))}`, [
                propstatOk([
                    ...resourceProps({
                        path,
                        isCollection: true,
                        quotaUsed: used,
                        quotaAvailable: Math.max(0, total - used),
                        locks: lockManager.listForPath(path.id),
                    }),
                    ...deadXml,
                ]),
            ]),
        );
    } else {
        const deadXml = await deadPropsXml(drive, mountId, path.id);
        responses.push(
            response(`${baseHref}${encodeHref(pathStr)}`, [
                propstatOk([
                    ...resourceProps({
                        path,
                        isCollection: false,
                        locks: lockManager.listForPath(path.id),
                    }),
                    ...deadXml,
                ]),
            ]),
        );
    }

    if (isCollection && depth === '1') {
        const children = await drive.getFolderContents(mountId, path.id);
        const parentHref = withTrailingSlash(pathStr);
        for (const child of children) {
            const childIsCollection = isContainerType(child.type);
            const childPath = `${parentHref}${child.name}${childIsCollection ? '/' : ''}`;
            // N+1 dead-prop fetch per child. Acceptable for v1; revisit if Finder
            // listings of large folders show up in profiling.
            const deadXml = await deadPropsXml(drive, mountId, child.id);
            responses.push(
                response(`${baseHref}${encodeHref(childPath)}`, [
                    propstatOk([
                        ...resourceProps({
                            path: child,
                            isCollection: childIsCollection,
                            locks: lockManager.listForPath(child.id),
                        }),
                        ...deadXml,
                    ]),
                ]),
            );
        }
    }

    return buildXmlResponse(multistatus(responses));
}
