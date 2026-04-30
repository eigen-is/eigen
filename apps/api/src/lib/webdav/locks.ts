import { randomUUID } from 'node:crypto';
import type { ProtocolUser } from '../auth/protocol-auth';
import { ApiError } from '../core/errors';
import { getWebdavDrive } from './get-drive';
import { WebdavPathCache } from './path-resolve';
import { lockdiscoveryProp } from './xml';

export type Lock = {
    token: string;
    pathId: string;
    ownerHref?: string;
    depth: 0 | 'infinity';
    expiresAt: number;
    userId: string;
};

const DEFAULT_TTL_MS = 600_000;

export class LockManager {
    private locks = new Map<string, Lock>();
    private byPath = new Map<string, Set<string>>();

    private gc(): void {
        const now = Date.now();
        for (const [token, lock] of this.locks) {
            if (lock.expiresAt <= now) {
                this.locks.delete(token);
                this.byPath.get(lock.pathId)?.delete(token);
            }
        }
    }

    acquire(args: { pathId: string; depth: 0 | 'infinity'; userId: string; ownerHref?: string; ttlMs?: number }): Lock {
        this.gc();
        const existing = this.byPath.get(args.pathId);
        if (existing) {
            for (const token of existing) {
                const held = this.locks.get(token);
                if (held && held.userId !== args.userId) {
                    throw new ApiError(423, 'Locked');
                }
            }
        }
        const token = `urn:uuid:${randomUUID()}`;
        const lock: Lock = {
            token,
            pathId: args.pathId,
            ownerHref: args.ownerHref,
            depth: args.depth,
            userId: args.userId,
            expiresAt: Date.now() + (args.ttlMs ?? DEFAULT_TTL_MS),
        };
        this.locks.set(token, lock);
        let pathTokens = this.byPath.get(args.pathId);
        if (!pathTokens) {
            pathTokens = new Set();
            this.byPath.set(args.pathId, pathTokens);
        }
        pathTokens.add(token);
        return lock;
    }

    refresh(token: string, ttlMs = DEFAULT_TTL_MS): Lock | null {
        const lock = this.locks.get(token);
        if (!lock || lock.expiresAt <= Date.now()) return null;
        lock.expiresAt = Date.now() + ttlMs;
        return lock;
    }

    release(token: string): boolean {
        const lock = this.locks.get(token);
        if (!lock) return false;
        this.locks.delete(token);
        this.byPath.get(lock.pathId)?.delete(token);
        return true;
    }

    listForPath(pathId: string): Lock[] {
        this.gc();
        const tokens = this.byPath.get(pathId);
        if (!tokens) return [];
        const out: Lock[] = [];
        for (const token of tokens) {
            const lock = this.locks.get(token);
            if (lock) out.push(lock);
        }
        return out;
    }

    isWriteAllowed(pathId: string, ifHeader: string | null, userId: string): boolean {
        const active = this.listForPath(pathId);
        if (active.length === 0) return true;
        const tokens = parseIfHeaderTokens(ifHeader);
        return active.every((lock) => lock.userId === userId && tokens.includes(lock.token));
    }
}

// RFC 4918 §10.4 If-header tokens are wrapped in `<...>`. We extract every angle-bracketed
// token; `(<token>)` and bare `<token>` both work. State-tokens vs etags are distinguished
// by the `urn:` scheme; callers (PUT/DELETE) only care about lock tokens here.
export function parseIfHeaderTokens(header: string | null): string[] {
    if (!header) return [];
    return [...header.matchAll(/<([^>]+)>/g)].map((m) => m[1]);
}

export const lockManager = new LockManager();

function parseTimeoutHeader(header: string | null): number {
    if (!header) return DEFAULT_TTL_MS;
    const match = header.match(/Second-(\d+)/i);
    return match ? Number(match[1]) * 1000 : DEFAULT_TTL_MS;
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
    const drive = await getWebdavDrive(ownerId, user);
    const cache = new WebdavPathCache();
    const path = await cache.resolve(drive, mountId, pathStr);
    if (!path) throw new ApiError(404, 'Not found');

    const ttlMs = parseTimeoutHeader(timeoutHeader);
    const depth: 0 | 'infinity' = depthHeader === '0' ? 0 : 'infinity';

    // RFC 4918 §9.10.2: empty body + If header refreshes an existing lock token.
    if (!body.trim() && ifHeader) {
        for (const token of parseIfHeaderTokens(ifHeader)) {
            const refreshed = lockManager.refresh(token, ttlMs);
            if (refreshed) return buildLockResponse(refreshed);
        }
        throw new ApiError(412, 'No matching lock to refresh');
    }

    const ownerHref = extractLockOwner(body);
    const lock = lockManager.acquire({ pathId: path.id, depth, userId: user.id, ownerHref, ttlMs });
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
    const drive = await getWebdavDrive(ownerId, user);
    const path = await drive.resolvePath(mountId, pathStr);
    if (!path) throw new ApiError(404, 'Not found');

    const token = lockTokenHeader.replace(/^</, '').replace(/>$/, '');
    const lock = lockManager.listForPath(path.id).find((l) => l.token === token);
    if (!lock) return new Response(null, { status: 409 });
    if (lock.userId !== user.id) return new Response(null, { status: 403 });

    lockManager.release(token);
    return new Response(null, { status: 204 });
}
