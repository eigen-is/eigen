import { randomUUID } from 'node:crypto';
import { ApiError } from '../core/errors';

// In-memory WebDAV lock state for a single Drive (one per Home). Locks are scoped to the
// Drive that owns the path being locked, so they evict naturally when the Home unloads.
// Single-node only: a sharded deployment would need to back this with the per-mount DB
// or a central store keyed by (mountId, pathId).

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

    clear(): void {
        this.locks.clear();
        this.byPath.clear();
    }
}

// RFC 4918 §10.4 If-header tokens are wrapped in `<...>`. We extract every angle-bracketed
// token; `(<token>)` and bare `<token>` both work. State-tokens vs etags are distinguished
// by the `urn:` scheme; callers (PUT/DELETE) only care about lock tokens here.
export function parseIfHeaderTokens(header: string | null): string[] {
    if (!header) return [];
    return [...header.matchAll(/<([^>]+)>/g)].map((m) => m[1]);
}

export const LOCK_DEFAULT_TTL_MS = DEFAULT_TTL_MS;
