import type { DrivePath } from '@workspace/lib/types/drive';
import { ApiError } from '../core/errors';
import { parseXmlRoot, serializeXmlChildren, type XmlElement, xmlChild } from '../core/xml';
import { DAV_NAMESPACES, XML_CONTENT_TYPE } from '../dav/xml';
import { getSharedDrive } from '../drive/get-drive';
import type { Lock, LockManager } from '../drive/lock-manager';
import { LOCK_DEFAULT_TTL_MS, parseIfHeaderTokens } from '../drive/lock-manager';
import type { User } from '../user';
import { lockdiscoveryProp, MAX_XML_BODY_BYTES } from './xml';

const DAV = DAV_NAMESPACES.D;

// Cap at 24h. RFC 4918 §10.7 lets the server ignore the requested timeout, and
// without a cap an authenticated client could pin in-memory lock state for years
// (Second-2147483647 ≈ 68y) — the LockManager only GCs expired entries.
const LOCK_MAX_TTL_MS = 24 * 60 * 60 * 1000;

function parseTimeoutHeader(header: string | null): number {
    if (!header) return LOCK_DEFAULT_TTL_MS;
    const match = header.match(/Second-(\d+)/i);
    if (!match) return LOCK_DEFAULT_TTL_MS;
    return Math.min(Number(match[1]) * 1000, LOCK_MAX_TTL_MS);
}

// RFC 4918 §6.2: depth-infinity locks on a collection cover every member, so a
// write on a descendant must satisfy the ancestor lock. The breadcrumb is
// root-to-self; we split it into the path itself (last) and ancestors (rest).
export function assertWritable(
    lockManager: LockManager,
    breadcrumb: DrivePath[],
    ifHeader: string | null,
    userId: string,
): void {
    const pathId = breadcrumb[breadcrumb.length - 1].id;
    const ancestorIds = breadcrumb.slice(0, -1).map((p) => p.id);
    if (!lockManager.isWriteAllowed(pathId, ifHeader, userId, ancestorIds)) {
        throw new ApiError(423, 'Locked');
    }
}

// RFC 4918 §14.17: the owner is the client's own XML, echoed back as XML in every lockdiscovery. Each child
// declares the bindings it uses, so an owner can outgrow its body; it is held for the lock's life, under the dead props' cap.
function readLockOwner(lockinfo: XmlElement): string | undefined {
    const element = xmlChild(lockinfo, DAV, 'owner');
    const owner = element && serializeXmlChildren(element).trim();
    if (owner && Buffer.byteLength(owner) > MAX_XML_BODY_BYTES) throw new ApiError(400, 'Lock owner too large');
    return owner || undefined;
}

function buildLockResponse(lock: Lock): Response {
    const body = `<?xml version="1.0" encoding="utf-8"?>
<D:prop xmlns:D="DAV:">${lockdiscoveryProp([lock])}</D:prop>`;
    return new Response(body, {
        status: 200,
        headers: {
            'Content-Type': XML_CONTENT_TYPE,
            'Lock-Token': `<${lock.token}>`,
        },
    });
}

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
    if (!path) throw new ApiError(404, 'Not found');

    const ttlMs = parseTimeoutHeader(timeoutHeader);
    const depth: Lock['depth'] = depthHeader === '0' ? 0 : 'infinity';
    const lockinfo = parseXmlRoot(body, DAV, 'lockinfo');

    // RFC 4918 §9.10.2: empty body + If header refreshes an existing lock token.
    if (!lockinfo && ifHeader) {
        for (const token of parseIfHeaderTokens(ifHeader)) {
            const refreshed = drive.lockManager.refresh(token, ttlMs);
            if (refreshed) return buildLockResponse(refreshed);
        }
        throw new ApiError(412, 'No matching lock to refresh');
    }

    // resolvePath only checks read on SharedDrive; a fresh lock implies pending
    // writes, so reject read-only collaborators before allocating a token.
    if (!(await drive.canWrite(mountId, path.id, user))) {
        throw new ApiError(403, 'No write permission');
    }

    const breadcrumb = await drive.breadCrumb(mountId, path.id);
    const ancestorPathIds = breadcrumb.slice(0, -1).map((p) => p.id);
    // Exclusive unless the body asks for shared, an omitted <lockscope> included (RFC 4918 §9.10).
    const lockscope = lockinfo && xmlChild(lockinfo, DAV, 'lockscope');
    const lock = drive.lockManager.acquire({
        pathId: path.id,
        depth,
        scope: lockscope && xmlChild(lockscope, DAV, 'shared') ? 'shared' : 'exclusive',
        userId: user.id,
        owner: lockinfo ? readLockOwner(lockinfo) : undefined,
        ttlMs,
        ifHeader,
        ancestorPathIds,
    });
    return buildLockResponse(lock);
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
