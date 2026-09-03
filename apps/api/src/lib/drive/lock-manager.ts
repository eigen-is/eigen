import { randomUUID } from 'node:crypto';
import { ApiError } from '../core/errors';

// In-memory WebDAV lock state for a single Drive (one per Home). Locks are scoped to the
// Drive that owns the path being locked, so they evict naturally when the Home unloads.
// Single-node only: a sharded deployment would need to back this with the per-mount DB
// or a central store keyed by (mountId, pathId).

export type LockScope = 'exclusive' | 'shared';

export type Lock = {
    token: string;
    pathId: string;
    ownerHref?: string;
    depth: 0 | 'infinity';
    scope: LockScope;
    expiresAt: number;
    userId: string;
};

export const LOCK_DEFAULT_TTL_MS = 600_000;

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

    acquire(args: {
        pathId: string;
        depth: 0 | 'infinity';
        scope: LockScope;
        userId: string;
        ownerHref?: string;
        ttlMs?: number;
        ifHeader?: string | null;
        ancestorPathIds?: string[];
    }): Lock {
        this.gc();
        // RFC 4918 §6.2 / §7.5: shared locks may coexist; an exclusive lock excludes
        // every other lock; any lock excludes a subsequent exclusive lock. New
        // requests that don't supply a current token in the If header must be
        // rejected if the existing locks would conflict. coveringLocks also surfaces
        // ancestor depth-infinity locks, so a child of a locked collection can't be
        // acquired without the ancestor's token.
        const heldLocks = this.coveringLocks(args.pathId, args.ancestorPathIds ?? []);
        if (heldLocks.length > 0) {
            const ifTokens = parseIfHeaderTokens(args.ifHeader ?? null);
            const hasAuthorizingToken = heldLocks.some((l) => ifTokens.includes(l.token));
            const conflicts = args.scope === 'exclusive' || heldLocks.some((l) => l.scope === 'exclusive');
            if (conflicts && !hasAuthorizingToken) {
                throw new ApiError(423, 'Locked');
            }
        }
        const token = `urn:uuid:${randomUUID()}`;
        const lock: Lock = {
            token,
            pathId: args.pathId,
            ownerHref: args.ownerHref,
            depth: args.depth,
            scope: args.scope,
            userId: args.userId,
            expiresAt: Date.now() + (args.ttlMs ?? LOCK_DEFAULT_TTL_MS),
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

    refresh(token: string, ttlMs = LOCK_DEFAULT_TTL_MS): Lock | null {
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

    // Drop every lock on a path (used when DELETE/MOVE/COPY remove or replace the
    // resource). Without this, lock state lingers until TTL — bounded but wasteful.
    releaseAllForPath(pathId: string): void {
        const tokens = this.byPath.get(pathId);
        if (!tokens) return;
        for (const token of tokens) this.locks.delete(token);
        this.byPath.delete(pathId);
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

    // Locks that cover a path: the path's own locks plus any depth=infinity lock on
    // an ancestor. Caller supplies the ancestor list (root-first) — usually from
    // Drive.breadCrumb minus the path itself. RFC 4918 §6.2 says depth-infinity locks
    // on a collection apply to every member.
    coveringLocks(pathId: string, ancestorPathIds: string[] = []): Lock[] {
        const own = this.listForPath(pathId);
        const ancestor = ancestorPathIds.flatMap((id) => this.listForPath(id).filter((l) => l.depth === 'infinity'));
        return [...own, ...ancestor];
    }

    isWriteAllowed(pathId: string, ifHeader: string | null, userId: string, ancestorPathIds: string[] = []): boolean {
        const active = this.coveringLocks(pathId, ancestorPathIds);
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
