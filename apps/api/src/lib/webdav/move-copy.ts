// The WebDAV MOVE and COPY methods. Both stay inside one mount of one owner, so a Destination anywhere
// else is a 502 and the client downloads and uploads again. The WebDAV router calls them with the
// signed-in user, and each goes through getSharedDrive, so the Drive ACL decides access. They apply the
// overwrite rules and the WebDAV locks as RFC 4918 asks, and tell the drive which path they checked under
// the destination name. The drive replaces that path, once nothing can refuse the write any more.

import type { DrivePath } from '@workspace/lib/types/drive';
import { DRIVE_TYPE_FILE } from '@workspace/lib/types/drive';
import { getApiBasePath } from '../config/env';
import { ApiError } from '../core/errors';
import type { DriveLike } from '../drive/get-drive';
import { getSharedDrive } from '../drive/get-drive';
import type { User } from '../user';
import { assertWritable } from './locks';
import { decodeHref, splitParentAndName } from './path';

type MoveCopyArgs = {
    user: User;
    ownerId: string;
    mountId: string;
    pathStr: string;
    requestUrl: string;
    destinationHeader: string | null;
    overwrite: boolean;
    ifHeader: string | null;
};

export async function handleMove(args: MoveCopyArgs): Promise<Response> {
    const { drive, src, destParent, destExisting, newName } = await resolveMoveCopy(args, 'MOVE');

    await drive.movePathOver(args.mountId, src.id, destParent.id, newName, destExisting?.id ?? null, args.user);
    return new Response(null, { status: destExisting ? 204 : 201 });
}

export async function handleCopy(args: MoveCopyArgs & { depth: '0' | '1' | 'infinity' }): Promise<Response> {
    const { drive, src, destParent, destExisting, newName } = await resolveMoveCopy(args, 'COPY');

    // RFC 4918 §9.8.3: Depth: 0 on a folder copies the folder without its members. A file has none.
    if (args.depth === '0' && src.type !== DRIVE_TYPE_FILE) {
        if (destExisting) throw new ApiError(412, 'Destination exists, a Depth 0 folder COPY never overwrites');
        await drive.createFolder(args.mountId, destParent.id, newName, args.user);
        return new Response(null, { status: 201 });
    }
    await drive.withHomeHeld(() =>
        drive.copyPathOver(args.mountId, src.id, destParent.id, newName, destExisting?.id ?? null, args.user),
    );
    return new Response(null, { status: destExisting ? 204 : 201 });
}

type Resolved = {
    drive: DriveLike;
    src: DrivePath;
    destParent: DrivePath;
    destExisting: DrivePath | null;
    newName: string;
};

async function resolveMoveCopy(args: MoveCopyArgs, verb: 'MOVE' | 'COPY'): Promise<Resolved> {
    const { user, ownerId, mountId, pathStr, requestUrl, destinationHeader, overwrite, ifHeader } = args;
    if (!destinationHeader) throw new ApiError(400, 'Missing Destination');
    const dest = parseDestination(destinationHeader, requestUrl);
    if (dest.ownerId !== ownerId) throw new ApiError(502, `Cross-owner ${verb}s not supported`);
    if (dest.mountId !== mountId) throw new ApiError(502, `Cross-mount ${verb}s not supported`);

    const drive = await getSharedDrive(ownerId, user);

    const src = await drive.resolvePath(mountId, pathStr);
    if (!src) throw new ApiError(404, 'Source not found');

    // A MOVE takes the source and everything under it out of its folder, so their locks count. A COPY leaves the
    // source as it is.
    const withMembers = async (path: DrivePath) =>
        assertWritable(drive, mountId, path.id, ifHeader, user.id, await drive.descendantIds(mountId, path.id));
    if (verb === 'MOVE') await withMembers(src);

    const { parentStr: destParentStr, name: newName } = splitParentAndName(dest.pathStr);
    if (!newName) throw new ApiError(400, 'Destination name missing');

    // A name is found without case, so a destination that differs from the source only in case finds the source
    // itself. That is a rename with nothing in its way, as Finder sends one.
    const found = await drive.resolvePath(mountId, dest.pathStr);
    const isSource = found?.id === src.id;
    // RFC 4918 §9.8.5 and §9.9.4: the same source and destination is a 403.
    if (isSource && newName.normalize('NFC') === src.name) {
        throw new ApiError(403, 'Source and destination are the same');
    }
    const destExisting = isSource ? null : found;
    if (destExisting && !overwrite) throw new ApiError(412, 'Destination exists, no overwrite');

    const destParent = await drive.resolvePath(mountId, destParentStr);
    if (!destParent) throw new ApiError(409, 'Destination parent not found');

    // An overwrite replaces destExisting with its members, which is a child of destParent.
    if (destExisting) await withMembers(destExisting);
    await assertWritable(drive, mountId, destParent.id, ifHeader, user.id);

    return { drive, src, destParent, destExisting, newName };
}

type DestParts = { ownerId: string; mountId: string; pathStr: string };

function parseDestination(destHeader: string, requestUrl: string): DestParts {
    let url: URL;
    try {
        url = new URL(destHeader, requestUrl);
    } catch {
        throw new ApiError(400, 'Invalid Destination header');
    }
    // A client sends back the full URL it was given, which carries the API's base path that the proxy stripped
    // from the request line. Only that one prefix is dropped, so a Destination on any other path stays a 400.
    const basePath = getApiBasePath();
    const pathname =
        basePath && url.pathname.startsWith(`${basePath}/`) ? url.pathname.slice(basePath.length) : url.pathname;
    const segments = decodeHref(pathname.replace(/^\/+webdav\/+/, '')).split('/');
    const [ownerId, mountId, ...rest] = segments;
    if (!ownerId || !mountId) throw new ApiError(400, 'Destination not under /webdav');
    const pathStr = `/${rest.join('/').replace(/\/+$/, '')}`;
    return { ownerId, mountId, pathStr };
}
