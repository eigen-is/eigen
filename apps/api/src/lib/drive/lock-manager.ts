// WebDAV locks for one Drive. A client such as an office app locks a file while it edits, and the
// manager decides which later requests may lock or write: shared locks can coexist, an exclusive
// lock excludes every other, and a folder lock reaches the items inside. A lock and its token count
// only for the user who took it. Locks live in memory and expire on their own, and while one lives
// the manager holds its Home open. The WebDAV handlers call it for LOCK, UNLOCK and every write.

import { ApiError } from '../core/errors';

type LockScope = 'exclusive' | 'shared';

export type Lock = {
    token: string;
    pathId: string;
    // The client's <D:owner> content, serialized XML written back as is.
    owner?: string;
    depth: 0 | 'infinity';
    scope: LockScope;
    expiresAt: number;
    userId: string;
};

export const LOCK_DEFAULT_TTL_MS = 600_000;
// Shared locks stack without conflict, so cap them per path or a client grows this table without bound.
const MAX_LOCKS_PER_PATH = 32;

export class LockManager {
    private readonly locks = new Map<string, Lock>();
    private readonly byPath = new Map<string, Set<string>>();
    private readonly hold: () => () => void;
    private releaseHold: (() => void) | undefined;
    private expiryTimer: Timer | undefined;

    public constructor(hold: () => () => void) {
        this.hold = hold;
    }

    public clear(): void {
        this.locks.clear();
        this.byPath.clear();
        this.settle();
    }

    public acquire(args: {
        pathId: string;
        depth: 0 | 'infinity';
        scope: LockScope;
        userId: string;
        owner?: string;
        ttlMs: number;
        ifHeader: string | null;
        ancestorPathIds: readonly string[];
        descendantPathIds: readonly string[];
    }): Lock {
        // RFC 4918 §6.2 and §7.5: two locks conflict when either is exclusive. Each lock in the new one's reach that
        // conflicts with it must be the caller's own, with its token in the If header, so no write meets two owners.
        const { covering, below } = this.inReach(args.pathId, args.ancestorPathIds, args.descendantPathIds);
        const owned = ownedWith(args.userId, args.ifHeader);
        const conflicts = (lock: Lock) => args.scope === 'exclusive' || lock.scope === 'exclusive';
        if ([...covering, ...below].some((lock) => conflicts(lock) && !owned(lock))) {
            throw new ApiError(423, 'Locked');
        }
        if ((this.byPath.get(args.pathId)?.size ?? 0) >= MAX_LOCKS_PER_PATH) {
            throw new ApiError(423, 'Too many locks');
        }
        // Every new lock asks for a hold, so a closing Home refuses it with its 503. One hold is enough.
        const release = this.hold();
        if (this.releaseHold) release();
        else this.releaseHold = release;
        const token = `urn:uuid:${crypto.randomUUID()}`;
        const lock: Lock = {
            token,
            pathId: args.pathId,
            owner: args.owner,
            depth: args.depth,
            scope: args.scope,
            userId: args.userId,
            expiresAt: Date.now() + args.ttlMs,
        };
        this.locks.set(token, lock);
        const pathTokens = this.byPath.get(args.pathId) ?? new Set<string>();
        pathTokens.add(token);
        this.byPath.set(args.pathId, pathTokens);
        this.settle();
        return lock;
    }

    public refresh(pathId: string, userId: string, ifHeader: string | null, ttlMs: number): Lock | undefined {
        const lock = this.listForPath(pathId).find(ownedWith(userId, ifHeader));
        if (!lock) return undefined;
        lock.expiresAt = Date.now() + ttlMs;
        this.settle();
        return lock;
    }

    public release(token: string): void {
        const lock = this.locks.get(token);
        if (!lock) return;
        this.drop(lock);
        this.settle();
    }

    public releaseAllForPaths(pathIds: readonly string[]): void {
        for (const pathId of pathIds) {
            for (const token of this.byPath.get(pathId) ?? []) this.locks.delete(token);
            this.byPath.delete(pathId);
        }
        this.settle();
    }

    public listForPath(pathId: string): Lock[] {
        this.gc();
        return [...(this.byPath.get(pathId) ?? [])].flatMap((token) => this.locks.get(token) ?? []);
    }

    // The locks covering one path are all shared or all one user's, so the token of one the caller owns passes them.
    // The locks below are other paths' locks, so a write that takes those paths along needs the token of each.
    public isWriteAllowed(
        pathId: string,
        ifHeader: string | null,
        userId: string,
        ancestorPathIds: readonly string[],
        descendantPathIds: readonly string[],
    ): boolean {
        const { covering, below } = this.inReach(pathId, ancestorPathIds, descendantPathIds);
        const owned = ownedWith(userId, ifHeader);
        return (covering.length === 0 || covering.some(owned)) && below.every(owned);
    }

    // RFC 4918 §6.2 applies a depth-infinity lock on a folder to every member, so those above the path cover it too.
    // The descendants are empty unless the request reaches them, as a depth-infinity LOCK or a folder's DELETE does.
    private inReach(
        pathId: string,
        ancestorPathIds: readonly string[],
        descendantPathIds: readonly string[],
    ): { covering: Lock[]; below: Lock[] } {
        const own = this.listForPath(pathId);
        const ancestor = ancestorPathIds.flatMap((id) => this.listForPath(id).filter((l) => l.depth === 'infinity'));
        const under = new Set(descendantPathIds);
        const below = [...this.locks.values()].filter((lock) => under.has(lock.pathId));
        return { covering: [...own, ...ancestor], below };
    }

    // Runs on every read, so it moves the timer only when a lock went.
    private gc(): void {
        const now = Date.now();
        let dropped = false;
        for (const lock of this.locks.values()) {
            if (lock.expiresAt > now) continue;
            this.drop(lock);
            dropped = true;
        }
        if (dropped) this.settle();
    }

    private drop(lock: Lock): void {
        this.locks.delete(lock.token);
        const pathTokens = this.byPath.get(lock.pathId);
        pathTokens?.delete(lock.token);
        if (pathTokens?.size === 0) this.byPath.delete(lock.pathId);
    }

    // One timer, at the latest expiry: until then some lock lives, so the hold stays. With no lock
    // left, the hold goes.
    private settle(): void {
        clearTimeout(this.expiryTimer);
        this.expiryTimer = undefined;
        if (this.locks.size === 0) {
            this.releaseHold?.();
            this.releaseHold = undefined;
            return;
        }
        let latest = 0;
        for (const lock of this.locks.values()) latest = Math.max(latest, lock.expiresAt);
        // Settles even when the timer fired a moment early and gc dropped nothing, so the hold never stays
        // without a timer. Unref'd, so a lock never keeps the process alive at shutdown.
        const expire = () => {
            this.gc();
            this.settle();
        };
        this.expiryTimer = setTimeout(expire, Math.max(0, latest - Date.now())).unref();
    }
}

// RFC 4918 §10.4 wraps each token of an If header in angle brackets, as in `(<token>)` or a bare
// `<token>`. The callers compare the result with lock tokens only.
export function parseIfHeaderTokens(header: string | null): string[] {
    if (!header) return [];
    return [...header.matchAll(/<([^>]+)>/g)].map((m) => m[1]);
}

// A token counts only for the user who took its lock, so one user can't pass a lock with another's token.
function ownedWith(userId: string, ifHeader: string | null): (lock: Lock) => boolean {
    const tokens = parseIfHeaderTokens(ifHeader);
    return (lock) => lock.userId === userId && tokens.includes(lock.token);
}
