import type { ProtocolUser } from '../auth/protocol-auth';
import { ApiError } from '../core/errors';
import { getSharedDrive } from '../drive/get-drive';
import type { Lock, LockScope } from '../drive/lock-manager';
import { LOCK_DEFAULT_TTL_MS, parseIfHeaderTokens } from '../drive/lock-manager';
import { WebdavPathCache } from './path-resolve';
import { lockdiscoveryProp } from './xml';

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
// write on a descendant must satisfy the ancestor lock. Walk the breadcrumb to
// collect ancestor IDs and ask the LockManager to consider both layers.
export async function assertWritable(
    drive: Awaited<ReturnType<typeof getSharedDrive>>,
    mountId: string,
    pathId: string,
    ifHeader: string | null,
    userId: string,
): Promise<void> {
    const breadcrumb = await drive.breadCrumb(mountId, pathId);
    const ancestorIds = breadcrumb.slice(0, -1).map((p) => p.id);
    if (!drive.lockManager.isWriteAllowed(pathId, ifHeader, userId, ancestorIds)) {
        throw new ApiError(423, 'Locked');
    }
}

// RFC 4918 §14.17 owner element. Accept both prefixed (<D:owner>) and default-namespace
// (<owner xmlns="DAV:">) shapes — curl's example bodies use the latter.
function extractLockOwner(body: string): string | undefined {
    const match = body.match(/<(?:[A-Za-z][\w]*:)?owner(?:\s[^>]*)?>([\s\S]*?)<\/(?:[A-Za-z][\w]*:)?owner>/i);
    return match?.[1].trim() || undefined;
}

// Default to exclusive when the body omits <lockscope> entirely (RFC 4918 §9.10).
function extractLockScope(body: string): LockScope {
    return /<(?:[A-Za-z][\w]*:)?shared\s*\/?>/i.test(body) ? 'shared' : 'exclusive';
}

function buildLockResponse(lock: Lock): Response {
    const body = `<?xml version="1.0" encoding="utf-8"?>
<D:prop xmlns:D="DAV:">${lockdiscoveryProp([lock])}</D:prop>`;
    return new Response(body, {
        status: 200,
        headers: {
            'Content-Type': 'application/xml; charset=utf-8',
            'Lock-Token': `<${lock.token}>`,
        },
    });
}

export async function handleLock(args: {
    user: ProtocolUser;
    ownerId: string;
    mountId: string;
    pathStr: string;
    body: string;
    timeoutHeader: string | null;
    ifHeader: string | null;
    depthHeader: string | null;
}): Promise<Response> {
    const { user, ownerId, mountId, pathStr, body, timeoutHeader, ifHeader, depthHeader } = args;
    const drive = await getSharedDrive(ownerId, user);
    const cache = new WebdavPathCache();
    const path = await cache.resolve(drive, mountId, pathStr);
    if (!path) throw new ApiError(404, 'Not found');

    const ttlMs = parseTimeoutHeader(timeoutHeader);
    const depth: 0 | 'infinity' = depthHeader === '0' ? 0 : 'infinity';

    // RFC 4918 §9.10.2: empty body + If header refreshes an existing lock token.
    if (!body.trim() && ifHeader) {
        for (const token of parseIfHeaderTokens(ifHeader)) {
            const refreshed = drive.lockManager.refresh(token, ttlMs);
            if (refreshed) return buildLockResponse(refreshed);
        }
        throw new ApiError(412, 'No matching lock to refresh');
    }

    const ownerHref = extractLockOwner(body);
    const scope = extractLockScope(body);
    const breadcrumb = await drive.breadCrumb(mountId, path.id);
    const ancestorPathIds = breadcrumb.slice(0, -1).map((p) => p.id);
    const lock = drive.lockManager.acquire({
        pathId: path.id,
        depth,
        scope,
        userId: user.id,
        ownerHref,
        ttlMs,
        ifHeader,
        ancestorPathIds,
    });
    return buildLockResponse(lock);
}

export async function handleUnlock(args: {
    user: ProtocolUser;
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
