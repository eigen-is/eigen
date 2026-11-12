// The WebDAV LOCK and UNLOCK methods, and the lock check every WebDAV write makes. The WebDAV router
// calls them with the signed-in user, and each one goes through getSharedDrive, so the Drive ACL
// decides access. A LOCK on a name with nothing there yet creates the empty file, as Office's
// "Save as" needs. The locks themselves live in the Drive's LockManager.

import type { DrivePath } from '@workspace/lib/types/drive';
import { ApiError } from '../core/errors';
import type { XmlElement } from '../core/xml';
import { parseXmlRoot, serializeXmlChildren, xmlChild } from '../core/xml';
import { DAV_NAMESPACES, XML_CONTENT_TYPE, XML_DECLARATION } from '../dav/xml';
import { getSharedDrive } from '../drive/get-drive';
import type { Lock, LockManager } from '../drive/lock-manager';
import { LOCK_DEFAULT_TTL_MS, parseIfHeaderTokens } from '../drive/lock-manager';
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

    const ttlMs = parseTimeoutHeader(timeoutHeader);
    const lockinfo = parseXmlRoot(body, DAV, 'lockinfo');

    // RFC 4918 §9.10.2: a LOCK with no body and an If header refreshes the lock it names.
    if (!lockinfo && ifHeader) {
        if (!path) throw new ApiError(404, 'Not found');
        for (const token of parseIfHeaderTokens(ifHeader)) {
            const refreshed = drive.lockManager.refresh(token, ttlMs);
            if (refreshed) return buildLockResponse(refreshed, 200);
        }
        throw new ApiError(412, 'No matching lock to refresh');
    }

    // Exclusive unless the body asks for shared, an omitted <lockscope> included (RFC 4918 §9.10).
    const lockscope = lockinfo && xmlChild(lockinfo, DAV, 'lockscope');
    const scope = lockscope && xmlChild(lockscope, DAV, 'shared') ? 'shared' : 'exclusive';
    const owner = lockinfo ? readLockOwner(lockinfo) : undefined;
    const lockOn = (pathId: string, ancestorPathIds: readonly string[], lockScope: Lock['scope']): Lock =>
        drive.lockManager.acquire({
            pathId,
            depth: depthHeader === '0' ? 0 : 'infinity',
            scope: lockScope,
            userId: user.id,
            owner,
            ttlMs,
            ifHeader,
            ancestorPathIds,
        });

    // resolvePath only checks read. A new lock means writes will follow, so a reader is refused before a
    // token is made.
    if (path) {
        if (!(await drive.canWrite(mountId, path.id, user))) throw new ApiError(403, 'No write permission');
        const ancestorIds = (await drive.breadCrumb(mountId, path.id)).slice(0, -1).map((p) => p.id);
        return buildLockResponse(lockOn(path.id, ancestorIds, scope), 200);
    }

    // RFC 4918 §7.3: a LOCK on an unmapped name creates an empty file, as an empty PUT would.
    const { parentStr, name } = splitParentAndName(pathStr);
    const parent = await drive.resolvePath(mountId, parentStr);
    if (!parent) throw new ApiError(409, 'Parent not found');
    if (!(await drive.canWrite(mountId, parent.id, user))) throw new ApiError(403, 'No write permission');
    const ancestorPathIds = (await drive.breadCrumb(mountId, parent.id)).map((p) => p.id);
    // The name itself is locked, exclusively, until the create lands: a second LOCK on it is a 423, not a second file.
    const nameLock = lockOn(`${parent.id}/${foldName(name)}`, ancestorPathIds, 'exclusive');
    const mimeType = Bun.file(name).type || 'application/octet-stream';
    const created = await drive
        .createFileFromData(mountId, parent.id, name, mimeType, Buffer.alloc(0), user)
        .finally(() => drive.lockManager.release(nameLock.token));
    return buildLockResponse(lockOn(created.id, ancestorPathIds, scope), 201);
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
// pass the locks of its ancestors. The breadcrumb runs from the root to the path itself.
export function assertWritable(
    lockManager: LockManager,
    breadcrumb: readonly DrivePath[],
    ifHeader: string | null,
    userId: string,
): void {
    const pathId = breadcrumb[breadcrumb.length - 1].id;
    const ancestorIds = breadcrumb.slice(0, -1).map((p) => p.id);
    if (!lockManager.isWriteAllowed(pathId, ifHeader, userId, ancestorIds)) {
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
