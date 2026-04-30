import type { ProtocolUser } from '../auth/protocol-auth';
import { ApiError } from '../core/errors';
import { getSharedDrive } from '../drive/get-drive';
import type { Lock } from '../drive/lock-manager';
import { LOCK_DEFAULT_TTL_MS, parseIfHeaderTokens } from '../drive/lock-manager';
import { WebdavPathCache } from './path-resolve';
import { lockdiscoveryProp } from './xml';

function parseTimeoutHeader(header: string | null): number {
    if (!header) return LOCK_DEFAULT_TTL_MS;
    const match = header.match(/Second-(\d+)/i);
    return match ? Number(match[1]) * 1000 : LOCK_DEFAULT_TTL_MS;
}

// RFC 4918 §14.17 owner element. Accept both prefixed (<D:owner>) and default-namespace
// (<owner xmlns="DAV:">) shapes — curl's example bodies use the latter.
function extractLockOwner(body: string): string | undefined {
    const match = body.match(/<(?:[A-Za-z][\w]*:)?owner(?:\s[^>]*)?>([\s\S]*?)<\/(?:[A-Za-z][\w]*:)?owner>/i);
    return match?.[1].trim() || undefined;
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
    const lock = drive.lockManager.acquire({ pathId: path.id, depth, userId: user.id, ownerHref, ttlMs });
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
