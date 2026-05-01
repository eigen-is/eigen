import type { DrivePath } from '@workspace/lib/types/drive';
import type { ProtocolUser } from '../auth/protocol-auth';
import { ApiError } from '../core/errors';
import type Drive from '../drive/drive';
import { getSharedDrive } from '../drive/get-drive';
import type SharedDrive from '../drive/sharedDrive';
import { assertWritable } from './locks';
import { WebdavPathCache } from './path-resolve';

type DestParts = { ownerId: string; mountId: string; pathStr: string };

function parseDestination(destHeader: string, requestUrl: string): DestParts {
    let url: URL;
    try {
        url = new URL(destHeader, requestUrl);
    } catch {
        throw new ApiError(400, 'Invalid Destination header');
    }
    const segments = url.pathname.replace(/^\/+webdav\/+/, '').split('/');
    const [ownerId, mountId, ...rest] = segments;
    if (!ownerId || !mountId) throw new ApiError(400, 'Destination not under /webdav');
    const pathStr = `/${rest.join('/').replace(/\/+$/, '')}`;
    return { ownerId, mountId, pathStr };
}

type Resolved = {
    drive: Drive | SharedDrive;
    src: DrivePath;
    destMountId: string;
    destParent: DrivePath;
    destExisting: DrivePath | null;
    newName: string;
};

async function resolveMoveCopy(args: {
    user: ProtocolUser;
    ownerId: string;
    mountId: string;
    pathStr: string;
    requestUrl: string;
    destinationHeader: string | null;
    overwrite: boolean;
    ifHeader: string | null;
    verb: 'MOVE' | 'COPY';
}): Promise<Resolved | Response> {
    const { user, ownerId, mountId, pathStr, requestUrl, destinationHeader, overwrite, ifHeader, verb } = args;
    if (!destinationHeader) throw new ApiError(400, 'Missing Destination');
    const dest = parseDestination(destinationHeader, requestUrl);
    if (dest.ownerId !== ownerId) throw new ApiError(502, `Cross-owner ${verb}s not supported`);

    const drive = await getSharedDrive(ownerId, user);
    const cache = new WebdavPathCache();

    const src = await cache.resolve(drive, mountId, pathStr);
    if (!src) throw new ApiError(404, 'Source not found');
    if (verb === 'MOVE' && (await drive.isInsideContainer(mountId, src.id))) {
        throw new ApiError(423, 'Container internals are read-only');
    }
    // MOVE removes from src so a lock on src must be honoured. COPY leaves src untouched.
    if (verb === 'MOVE') {
        await assertWritable(drive, mountId, src.id, ifHeader, user.id);
    }

    const destPathStr = dest.pathStr || '/';
    const destExisting = await cache.resolve(drive, dest.mountId, destPathStr);
    if (destExisting && !overwrite) return new Response(null, { status: 412 });
    if (destExisting && (await drive.isInsideContainer(dest.mountId, destExisting.id))) {
        throw new ApiError(423, 'Container internals are read-only');
    }
    if (destExisting) {
        await assertWritable(drive, dest.mountId, destExisting.id, ifHeader, user.id);
    }

    const lastSlash = destPathStr.lastIndexOf('/');
    const destParentStr = destPathStr.slice(0, lastSlash) || '/';
    const newName = destPathStr.slice(lastSlash + 1).normalize('NFC');
    if (!newName) throw new ApiError(400, 'Destination name missing');

    const destParent = await cache.resolve(drive, dest.mountId, destParentStr);
    if (!destParent) throw new ApiError(409, 'Destination parent not found');
    if (await drive.isContainerWriteBlocked(dest.mountId, destParent.id)) {
        throw new ApiError(423, 'Container internals are read-only');
    }
    await assertWritable(drive, dest.mountId, destParent.id, ifHeader, user.id);

    return { drive, src, destMountId: dest.mountId, destParent, destExisting, newName };
}

export async function handleMove(args: {
    user: ProtocolUser;
    ownerId: string;
    mountId: string;
    pathStr: string;
    requestUrl: string;
    destinationHeader: string | null;
    overwrite: boolean;
    ifHeader: string | null;
}): Promise<Response> {
    const resolved = await resolveMoveCopy({ ...args, verb: 'MOVE' });
    if (resolved instanceof Response) return resolved;
    const { drive, src, destMountId, destParent, destExisting, newName } = resolved;

    if (destExisting) await drive.deletePath(destMountId, destExisting.id);

    if (args.mountId === destMountId) {
        if (src.parentId !== destParent.id) {
            await drive.movePath(args.mountId, src.id, destParent.id);
        }
        if (src.name !== newName) {
            await drive.renamePath(args.mountId, src.id, newName);
        }
    } else {
        await drive.copyPathCrossMount(args.mountId, src.id, destMountId, destParent.id, newName);
        await drive.deletePath(args.mountId, src.id);
        // Cross-mount MOVE creates a new pathId at the destination; the source
        // pathId is gone, so its locks are unreachable. Release them explicitly
        // (in-mount MOVE keeps the same pathId, so no release is needed there).
        for (const lock of drive.lockManager.listForPath(src.id)) {
            drive.lockManager.release(lock.token);
        }
    }
    return new Response(null, { status: destExisting ? 204 : 201 });
}

export async function handleCopy(args: {
    user: ProtocolUser;
    ownerId: string;
    mountId: string;
    pathStr: string;
    requestUrl: string;
    destinationHeader: string | null;
    overwrite: boolean;
    ifHeader: string | null;
    depth: '0' | '1' | 'infinity';
}): Promise<Response> {
    const resolved = await resolveMoveCopy({ ...args, verb: 'COPY' });
    if (resolved instanceof Response) return resolved;
    const { drive, src, destMountId, destParent, destExisting, newName } = resolved;

    if (destExisting) await drive.deletePath(destMountId, destExisting.id);

    // RFC 4918 §9.8.3: Depth: 0 on a collection COPY means copy the collection
    // itself but NOT its members. Files are unaffected (they have no children).
    if (args.depth === '0' && src.type !== 'file') {
        await drive.createFolder(destMountId, destParent.id, newName);
    } else if (args.mountId === destMountId) {
        await drive.copyPath(args.mountId, src.id, destParent.id, newName);
    } else {
        await drive.copyPathCrossMount(args.mountId, src.id, destMountId, destParent.id, newName);
    }
    return new Response(null, { status: destExisting ? 204 : 201 });
}
