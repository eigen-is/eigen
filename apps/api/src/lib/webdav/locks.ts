// The WebDAV LOCK and UNLOCK methods, and the lock check every WebDAV write makes. The WebDAV router
// calls them with the signed-in user, and each one goes through getSharedDrive, so the Drive ACL
// decides access. A LOCK on a name with nothing there yet creates the empty file, as Office's
// "Save as" needs. The locks themselves, and the rule for who passes one, live in the Drive's LockManager.

import { ApiError } from '../core/errors';
import type { XmlElement } from '../core/xml';
import { parseXmlRoot, serializeXmlChildren, xmlChild } from '../core/xml';
import { DAV_NAMESPACES, XML_CONTENT_TYPE, XML_DECLARATION } from '../dav/xml';
import type { DriveLike } from '../drive/get-drive';
import { getSharedDrive } from '../drive/get-drive';
import type { Lock } from '../drive/lock-manager';
import { LOCK_DEFAULT_TTL_MS } from '../drive/lock-manager';
import { foldName } from '../mount/names';
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
    const lockOn = (
        pathId: string,
        lockScope: Lock['scope'],
        ancestorPathIds: readonly string[],
        descendantPathIds: readonly string[],
    ): Lock =>
        drive.lockManager.acquire({
            pathId,
            depth,
            scope: lockScope,
            userId: user.id,
            owner,
            ttlMs,
            ifHeader,
            ancestorPathIds,
            descendantPathIds,
        });

    if (path) {
        const ancestorIds = await drive.ancestorIds(mountId, path.id);
        const descendantIds = depth === 0 ? [] : await drive.descendantIds(mountId, path.id);
        return buildLockResponse(lockOn(path.id, scope, ancestorIds, descendantIds), 200);
    }

    // RFC 4918 §7.3: a LOCK on an unmapped name creates an empty file, as an empty PUT would.
    const { parentStr, name } = splitParentAndName(pathStr);
    const parent = await drive.resolvePath(mountId, parentStr);
    if (!parent) throw new ApiError(409, 'Parent not found');
    if (!(await drive.canWrite(mountId, parent.id, user))) throw new ApiError(403, 'No write permission');
    await assertWritable(drive, mountId, parent.id, ifHeader, user.id);
    const ancestorPathIds = [...(await drive.ancestorIds(mountId, parent.id)), parent.id];
    // The name itself is locked, exclusively, until the create lands: a second LOCK on it is a 423, not a second file.
    const nameLock = lockOn(`${parent.id}/${foldName(name)}`, 'exclusive', ancestorPathIds, []);
    const mimeType = Bun.file(name).type || 'application/octet-stream';
    const created = await drive
        .createFileFromData(mountId, parent.id, name, mimeType, Buffer.alloc(0), user)
        .finally(() => drive.lockManager.release(nameLock.token));
    return buildLockResponse(lockOn(created.id, scope, ancestorPathIds, []), 201);
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

// RFC 4918 §6.2: a depth-infinity lock on a folder covers everything below it, so a write must also
// pass the locks of every folder above the path, those the caller can't read included.
export async function assertWritable(
    drive: DriveLike,
    mountId: string,
    pathId: string,
    ifHeader: string | null,
    userId: string,
): Promise<void> {
    const ancestorIds = await drive.ancestorIds(mountId, pathId);
    if (!drive.lockManager.isWriteAllowed(pathId, ifHeader, userId, ancestorIds)) {
        throw new ApiError(423, 'Locked');
    }
}

function parseTimeoutHeader(header: string | null): number {
    if (!header) return LOCK_DEFAULT_TTL_MS;
    const match = header.match(/Second-(\d+)/i);
    if (!match) return LOCK_DEFAULT_TTL_MS;
    return Math.min(Number(match[1]) * 1000, LOCK_MAX_TTL_MS);
}

// RFC 4918 §14.17: the owner is the client's own XML, and every lockdiscovery sends it back as XML.
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
