import type { DrivePath } from '@workspace/lib/types/drive';
import { ApiError } from '../core/errors';
import { enclosingDocumentContainer } from '../drive/container-guard';
import { type DriveLike, getSharedDrive } from '../drive/get-drive';
import type { User } from '../user';
import { assertWritable } from './locks';

type DestParts = { ownerId: string; mountId: string; pathStr: string };

function parseDestination(destHeader: string, requestUrl: string): DestParts {
    let url: URL;
    try {
        url = new URL(destHeader, requestUrl);
    } catch {
        throw new ApiError(400, 'Invalid Destination header');
    }
    // url.pathname keeps percent-encoding ("/webdav/U/M/My%20Folder"); decode each
    // segment so the result matches in-database names.
    const segments = url.pathname
        .replace(/^\/+webdav\/+/, '')
        .split('/')
        .map(decodeURIComponent);
    const [ownerId, mountId, ...rest] = segments;
    if (!ownerId || !mountId) throw new ApiError(400, 'Destination not under /webdav');
    const pathStr = `/${rest.join('/').replace(/\/+$/, '')}`;
    return { ownerId, mountId, pathStr };
}

type Resolved = {
    drive: DriveLike;
    src: DrivePath;
    destParent: DrivePath;
    destExisting: DrivePath | null;
    newName: string;
};

async function resolveMoveCopy(args: {
    user: User;
    ownerId: string;
    mountId: string;
    pathStr: string;
    requestUrl: string;
    destinationHeader: string | null;
    overwrite: boolean;
    ifHeader: string | null;
    verb: 'MOVE' | 'COPY';
}): Promise<Resolved> {
    const { user, ownerId, mountId, pathStr, requestUrl, destinationHeader, overwrite, ifHeader, verb } = args;
    if (!destinationHeader) throw new ApiError(400, 'Missing Destination');
    const dest = parseDestination(destinationHeader, requestUrl);
    if (dest.ownerId !== ownerId) throw new ApiError(502, `Cross-owner ${verb}s not supported`);
    if (dest.mountId !== mountId) throw new ApiError(502, `Cross-mount ${verb}s not supported`);

    const drive = await getSharedDrive(ownerId, user);

    const src = await drive.resolvePath(mountId, pathStr);
    if (!src) throw new ApiError(404, 'Source not found');

    // Source side. MOVE removes from src so the container guard and lock
    // check both apply; COPY leaves src untouched and only needs the
    // (already done) resolve.
    if (verb === 'MOVE') {
        const srcBreadcrumb = await drive.breadCrumb(mountId, src.id);
        if (enclosingDocumentContainer(srcBreadcrumb, { includeSelf: false })) {
            throw new ApiError(423, 'Container internals are read-only');
        }
        assertWritable(drive.lockManager, srcBreadcrumb, ifHeader, user.id);
    }

    const destPathStr = dest.pathStr || '/';
    const destExisting = await drive.resolvePath(mountId, destPathStr);
    if (destExisting && !overwrite) throw new ApiError(412, 'Destination exists, no overwrite');

    const lastSlash = destPathStr.lastIndexOf('/');
    const destParentStr = destPathStr.slice(0, lastSlash) || '/';
    const newName = destPathStr.slice(lastSlash + 1).normalize('NFC');
    if (!newName) throw new ApiError(400, 'Destination name missing');

    const destParent = await drive.resolvePath(mountId, destParentStr);
    if (!destParent) throw new ApiError(409, 'Destination parent not found');

    // One destination-side breadcrumb fetch. destExisting's full chain (if
    // it exists) supplies destParent's chain via slice(0,-1); otherwise we
    // fetch destParent directly. The container guard runs on this chain;
    // the lock check runs on destExisting *and* destParent (overwrite
    // touches destExisting; either case adds/replaces a child of destParent).
    const destBreadcrumb = destExisting
        ? await drive.breadCrumb(mountId, destExisting.id)
        : await drive.breadCrumb(mountId, destParent.id);
    if (enclosingDocumentContainer(destBreadcrumb, { includeSelf: !destExisting })) {
        throw new ApiError(423, 'Container internals are read-only');
    }
    if (destExisting) {
        assertWritable(drive.lockManager, destBreadcrumb, ifHeader, user.id);
        assertWritable(drive.lockManager, destBreadcrumb.slice(0, -1), ifHeader, user.id);
    } else {
        assertWritable(drive.lockManager, destBreadcrumb, ifHeader, user.id);
    }

    return { drive, src, destParent, destExisting, newName };
}

export async function handleMove(args: {
    user: User;
    ownerId: string;
    mountId: string;
    pathStr: string;
    requestUrl: string;
    destinationHeader: string | null;
    overwrite: boolean;
    ifHeader: string | null;
}): Promise<Response> {
    const { drive, src, destParent, destExisting, newName } = await resolveMoveCopy({
        ...args,
        verb: 'MOVE',
    });

    if (destExisting) {
        await drive.deletePath(args.mountId, destExisting.id, args.user);
        drive.lockManager.releaseAllForPath(destExisting.id);
    }

    if (src.parentId !== destParent.id) {
        await drive.movePath(args.mountId, src.id, destParent.id, args.user);
    }
    if (src.name !== newName) {
        await drive.renamePath(args.mountId, src.id, newName, args.user);
    }
    return new Response(null, { status: destExisting ? 204 : 201 });
}

export async function handleCopy(args: {
    user: User;
    ownerId: string;
    mountId: string;
    pathStr: string;
    requestUrl: string;
    destinationHeader: string | null;
    overwrite: boolean;
    ifHeader: string | null;
    depth: '0' | '1' | 'infinity';
}): Promise<Response> {
    const { drive, src, destParent, destExisting, newName } = await resolveMoveCopy({
        ...args,
        verb: 'COPY',
    });

    if (destExisting) {
        await drive.deletePath(args.mountId, destExisting.id, args.user);
        drive.lockManager.releaseAllForPath(destExisting.id);
    }

    // RFC 4918 §9.8.3: Depth: 0 on a collection COPY means copy the collection
    // itself but NOT its members. Files are unaffected (they have no children).
    if (args.depth === '0' && src.type !== 'file') {
        await drive.createFolder(args.mountId, destParent.id, newName, args.user);
    } else {
        await drive.copyPath(args.mountId, src.id, destParent.id, newName, args.user);
    }
    return new Response(null, { status: destExisting ? 204 : 201 });
}
