// The WebDAV LOCK and UNLOCK methods, and the lock check every WebDAV write makes. The WebDAV router
// calls them with the signed-in user, and each one goes through getSharedDrive, so the Drive ACL
// decides access. A LOCK on a name with nothing there yet creates the empty file, as Office's
// "Save as" needs. The locks themselves, and the rule for who passes one, live in the Drive's LockManager.

import type { DrivePath } from '@workspace/lib/types/drive';
import { ApiError } from '../core/errors';
import type { XmlElement } from '../core/xml';
import { parseXmlRoot, serializeXmlChildren, xmlChild } from '../core/xml';
import { DAV_NAMESPACES, XML_CONTENT_TYPE, XML_DECLARATION } from '../dav/xml';
import type { DriveLike } from '../drive/get-drive';
import { getSharedDrive } from '../drive/get-drive';
import type { Lock } from '../drive/lock-manager';
import { LOCK_DEFAULT_TTL_MS } from '../drive/lock-manager';
import type { User } from '../user';
import { splitParentAndName } from './path';
import { lockdiscoveryProp, MAX_XML_BODY_BYTES } from './xml';

const DAV = DAV_NAMESPACES.D;

// RFC 4918 §10.7 lets the server ignore the timeout a client asks for. Without this cap a client
// could keep a lock, and the Home the lock holds open, for years (Second-2147483647 is 68 years).
const LOCK_MAX_TTL_MS = 24 * 60 * 60 * 1000;

export async function handleLock(args: {
    user: User;
    ownerId: string;
    mountId: string;
    pathStr: string;
    body: Uint8Array;
    timeoutHeader: string | null;
    ifHeader: string | null;
    depthHeader: string | null;
}): Promise<Response> {
    const { user, ownerId, mountId, pathStr, body, timeoutHeader, ifHeader, depthHeader } = args;
    const drive = await getSharedDrive(ownerId, user);
    const path = await drive.resolvePath(mountId, pathStr);
    // resolvePath only checks read. A lock means writes will follow, so a reader takes or refreshes none.
    if (path && !(await drive.canWrite(mountId, path.id, user))) throw new ApiError(403, 'No write permission');

    const ttlMs = parseTimeoutHeader(timeoutHeader);
    const lockinfo = parseXmlRoot(body, DAV, 'lockinfo');

    // RFC 4918 §9.10.2: a LOCK with no body and an If header refreshes the lock it names.
    if (!lockinfo && ifHeader) {
        if (!path) throw new ApiError(404, 'Not found');
        const refreshed = drive.lockManager.refresh(path.id, user.id, ifHeader, ttlMs);
        if (!refreshed) throw new ApiError(412, 'No matching lock to refresh');
        return buildLockResponse(refreshed, 200);
    }

    // Exclusive unless the body asks for shared, an omitted <lockscope> included (RFC 4918 §9.10).
    const lockscope = lockinfo && xmlChild(lockinfo, DAV, 'lockscope');
    const scope = lockscope && xmlChild(lockscope, DAV, 'shared') ? 'shared' : 'exclusive';
    const owner = lockinfo ? readLockOwner(lockinfo) : undefined;
    const depth = depthHeader === '0' ? 0 : 'infinity';
    const lockOn = async (target: DrivePath, status: 200 | 201): Promise<Response> => {
        const ancestorPathIds = await drive.ancestorIds(mountId, target.id);
        const descendantPathIds = depth === 0 ? [] : await drive.descendantIds(mountId, target.id);
        const lock = drive.lockManager.acquire({
            pathId: target.id,
            depth,
            scope,
            userId: user.id,
            owner,
            ttlMs,
            ifHeader,
            ancestorPathIds,
            descendantPathIds,
        });
        return buildLockResponse(lock, status);
    };
    if (path) return lockOn(path, 200);

    // RFC 4918 §7.3: a LOCK on an unmapped name creates an empty file, as an empty PUT would.
    const { parentStr, name } = splitParentAndName(pathStr);
    const parent = await drive.resolvePath(mountId, parentStr);
    if (!parent) throw new ApiError(409, 'Parent not found');
    await assertWritable(drive, mountId, parent.id, ifHeader, user.id);
    const mimeType = Bun.file(name).type || 'application/octet-stream';
    return lockOn(await drive.createNamedFile(mountId, parent.id, name, mimeType, Buffer.alloc(0), user), 201);
}

export async function handleUnlock(args: {
    user: User;
    ownerId: string;
    mountId: string;
    pathStr: string;
    lockTokenHeader: string | null;
}): Promise<Response> {
    const { user, ownerId, mountId, pathStr, lockTokenHeader } = args;
    if (!lockTokenHeader) throw new ApiError(400, 'Missing Lock-Token');
    const drive = await getSharedDrive(ownerId, user);
    const path = await drive.resolvePath(mountId, pathStr);
    if (!path) throw new ApiError(404, 'Not found');

    const token = lockTokenHeader.replace(/^</, '').replace(/>$/, '');
    const lock = drive.lockManager.listForPath(path.id).find((l) => l.token === token);
    if (!lock) return new Response(null, { status: 409 });
    if (lock.userId !== user.id) return new Response(null, { status: 403 });

    drive.lockManager.release(token);
    return new Response(null, { status: 204 });
}

// RFC 4918 §9.6.1 and §9.9.2: a folder can't go while a member of it is locked, so a write that removes or moves
// a whole path passes its descendants, and the locks on them count too.
export async function assertWritable(
    drive: DriveLike,
    mountId: string,
    pathId: string,
    ifHeader: string | null,
    userId: string,
    descendantPathIds: readonly string[] = [],
): Promise<void> {
    const ancestorPathIds = await drive.ancestorIds(mountId, pathId);
    if (!drive.lockManager.isWriteAllowed(pathId, ifHeader, userId, ancestorPathIds, descendantPathIds)) {
        throw new ApiError(423, 'Locked');
    }
}

function parseTimeoutHeader(header: string | null): number {
    if (!header) return LOCK_DEFAULT_TTL_MS;
    const match = header.match(/Second-(\d+)/i);
    if (!match) return LOCK_DEFAULT_TTL_MS;
    return Math.min(Number(match[1]) * 1000, LOCK_MAX_TTL_MS);
}

// Each child declares the namespaces it uses, so an owner can grow past the size of its body. The lock
// keeps it for its whole life, so it gets the same cap as a body.
function readLockOwner(lockinfo: XmlElement): string | undefined {
    const element = xmlChild(lockinfo, DAV, 'owner');
    const owner = element && serializeXmlChildren(element).trim();
    if (owner && Buffer.byteLength(owner) > MAX_XML_BODY_BYTES) throw new ApiError(400, 'Lock owner too large');
    return owner || undefined;
}

function buildLockResponse(lock: Lock, status: 200 | 201): Response {
    const body = `${XML_DECLARATION}
<D:prop xmlns:D="DAV:">${lockdiscoveryProp([lock])}</D:prop>`;
    return new Response(body, {
        status,
        headers: {
            'Content-Type': XML_CONTENT_TYPE,
            'Lock-Token': `<${lock.token}>`,
        },
    });
}
