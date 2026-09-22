import { Database } from 'bun:sqlite';
import * as fs from 'node:fs';
import { isSafePathSegment } from './path-utils';

// The blob is the truth; every other column is a projection and is rebuildable from it. The shape both DAV domains share.

// macOS clients send the same name in NFD form in a URL, so one resource would otherwise answer under two spellings.
export function normalizeResourceUri(uri: string): string {
    return uri.normalize('NFC');
}

// The shared segment rule plus the suffix the resource carries: also what a calendar id and a mail draft id obey.
export function sanitizeResourceUri(raw: string, suffix: string): string | null {
    const uri = normalizeResourceUri(raw);
    return uri.endsWith(suffix) && isSafePathSegment(uri) ? uri : null;
}

// A recreated database must never reissue a generation a client has seen, so the wall clock in seconds seeds it.
export function newSyncGen(): number {
    return Math.floor(Date.now() / 1000);
}

// Sizes one domain's blobs for a Home nobody booted; the admin usage view sizes every home at once, and
// booting a Home apiece is seconds each. Read-write on purpose, following mount/helpers.ts readMountTotalSize:
// a read-only open of a WAL database whose owner is not holding it open fails outright.
export function readBlobTableSize(dbPath: string, table: string, column: string, currentVersion: number): number {
    if (!fs.existsSync(dbPath)) return 0;
    const db = new Database(dbPath, { readwrite: true, create: false });
    try {
        db.run('PRAGMA busy_timeout = 5000;');
        // A database this build does not recognise is sized by the build that does: the column may not exist
        // yet, or may no longer mean the same bytes. A missing stamp table is one of those.
        let stamp: number | null = null;
        try {
            stamp =
                db.query<{ version: number }, []>('SELECT version FROM __schema_version WHERE id = 1').get()?.version ??
                null;
        } catch {
            stamp = null;
        }
        if (stamp !== currentVersion) return 0;
        const row = db
            .query<{ total: number }, []>(`SELECT COALESCE(SUM(length(${column})), 0) AS total FROM ${table}`)
            .get();
        return row?.total ?? 0;
    } finally {
        db.close();
    }
}

// The two conditional headers both DAV write paths evaluate inside their write lock.
export type ResourcePreconditions = { ifMatch: string | null; ifNoneMatch: string | null };

export function computeResourceEtag(bytes: Uint8Array): string {
    return new Bun.CryptoHasher('sha256').update(bytes).digest('hex');
}

// The terms both DAV protocols carry a precondition element for: bytes that do not parse, a broken object, a foreign component.
export type InvalidReason = 'data' | 'object' | 'component';

// A client-caused failure is a value, not a throw; a null etag is a write not stored verbatim, which has no validator to hand back (RFC 4791 § 5.3.4).
// The id is the row the write landed on, read inside the lock: a facade announcing from it cannot lose the event to a racing delete.
export type PutResourceResult =
    | { ok: true; id: string; etag: string | null; created: boolean }
    | {
          ok: false;
          error: 'precondition' | 'uid-conflict' | 'invalid' | 'no-collection' | 'too-large' | 'quota';
          reason?: InvalidReason;
          message?: string;
          conflictUri?: string;
      };

// The id is the row the delete removed, read inside the lock, for the announcement the facade makes after it.
export type DeleteResourceResult = { ok: true; id: string } | { ok: false; error: 'not-found' | 'precondition' };

// A bulk write broadcasts one list-level event instead of one per resource, and the flush runs even when the body throws.
export class BroadcastBatch {
    private depth = 0;
    private held = false;

    constructor(private readonly flush: () => void) {}

    // True when the caller's event was held for the batch, false when it is the caller's to broadcast now.
    hold(): boolean {
        if (this.depth === 0) return false;
        this.held = true;
        return true;
    }

    async run<T>(fn: () => Promise<T>): Promise<T> {
        this.depth++;
        try {
            return await fn();
        } finally {
            this.depth--;
            if (this.depth === 0 && this.held) {
                this.held = false;
                this.flush();
            }
        }
    }
}
