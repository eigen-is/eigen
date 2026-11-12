// WebDAV locks for one Drive. A client such as an office app locks a file while it edits, and the
// manager decides which later requests may write: shared locks can coexist, an exclusive lock
// excludes the rest. It also covers a folder lock that reaches the items inside. Locks live in
// memory and expire on their own, and while one lives the manager holds its Home open. The WebDAV
// handlers call it for LOCK, UNLOCK and every write.

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

    // A WebDAV-only client, such as Word, sends nothing between its lock refreshes, longer than the
    // Home's idle time. So the manager holds the Home while it has a live lock, or the idle close
    // would drop the lock and anyone could overwrite the file.
    public constructor(hold: () => () => void) {
        this.hold = hold;
    }

    // The Home calls this when it closes for another reason, such as a restore or the shutdown.
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
    }): Lock {
        this.gc();
        // RFC 4918 §6.2 and §7.5: shared locks may coexist, and an exclusive lock excludes every other
        // lock. A request that conflicts must name one of its own current tokens in its If header. The covering
        // locks include a depth-infinity lock on an ancestor, so a child of a locked folder needs that token too.
        const heldLocks = this.coveringLocks(args.pathId, args.ancestorPathIds);
        const conflicts =
            heldLocks.length > 0 && (args.scope === 'exclusive' || heldLocks.some((l) => l.scope === 'exclusive'));
        if (conflicts && !heldLocks.some(ownedWith(args.userId, args.ifHeader))) {
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

    public refresh(token: string, ttlMs: number): Lock | null {
        const lock = this.locks.get(token);
        if (!lock || lock.expiresAt <= Date.now()) return null;
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

    // The Drive calls this when paths leave their place, such as by a trash or a WebDAV MOVE, with every
    // path under them. Their locks would otherwise keep the Home held until they expire.
    public releaseAllForPaths(pathIds: readonly string[]): void {
        for (const pathId of pathIds) {
            for (const token of this.byPath.get(pathId) ?? []) this.locks.delete(token);
            this.byPath.delete(pathId);
        }
        this.settle();
    }

    public listForPath(pathId: string): Lock[] {
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

    public isWriteAllowed(
        pathId: string,
        ifHeader: string | null,
        userId: string,
        ancestorPathIds: readonly string[],
    ): boolean {
        const active = this.coveringLocks(pathId, ancestorPathIds);
        if (active.length === 0) return true;
        const owned = ownedWith(userId, ifHeader);
        // One own token passes the shared locks. A folder lock is taken without looking below it, so another
        // user's exclusive lock can sit under it, and an exclusive lock passes only with its own token.
        return active.some(owned) && active.every((lock) => lock.scope === 'shared' || owned(lock));
    }

    // The path's own locks, and the depth-infinity locks on its ancestors, which RFC 4918 §6.2 applies
    // to every member. The caller passes the ancestors root first, usually a breadcrumb without the path.
    private coveringLocks(pathId: string, ancestorPathIds: readonly string[]): Lock[] {
        const own = this.listForPath(pathId);
        const ancestor = ancestorPathIds.flatMap((id) => this.listForPath(id).filter((l) => l.depth === 'infinity'));
        return [...own, ...ancestor];
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
