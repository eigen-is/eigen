// What the DAV stores share, such as the calendar's and the contacts': each row keeps the bytes a client wrote as
// the truth, and every other column is a projection rebuilt from them. Here live the resource name rule, the etag,
// the precondition check, the sync generation, a store's size for a Home nobody booted, and the results a PUT or a
// DELETE answers with.

import { Database } from 'bun:sqlite';
import * as fs from 'node:fs';
import { matchesIfMatch, matchesIfNoneMatch } from './http';
import { isSafePathSegment } from './path-utils';

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

// Sizes one domain's blobs without booting the Home: the admin usage view sizes every home at once, and a boot
// apiece is seconds each. Read-write, because a read-only open of a WAL database nobody holds open fails outright.
export function readBlobTableSize(dbPath: string, table: string, column: string): number {
    if (!fs.existsSync(dbPath)) return 0;
    const db = new Database(dbPath, { readwrite: true, create: false });
    try {
        db.run('PRAGMA busy_timeout = 5000;');
        const [row] = db
            .query<{ total: number }, []>(`SELECT COALESCE(SUM(length(${column})), 0) AS total FROM ${table}`)
            .all();
        return row.total;
    } catch {
        // A database this build does not recognise is sized by the build that does: the column may not exist yet.
        return 0;
    } finally {
        db.close();
    }
}

// The two conditional headers both DAV write paths evaluate.
export type ResourcePreconditions = { ifMatch: string | null; ifNoneMatch: string | null };

// Judged inside the write lock against the row a PUT overwrites, so the loser of two racing If-Match PUTs sees the winner's etag.
export function failsPreconditions(pre: ResourcePreconditions, storedEtag: string | undefined): boolean {
    const current = storedEtag === undefined ? null : `"${storedEtag}"`;
    return (
        (pre.ifNoneMatch !== null && matchesIfNoneMatch(pre.ifNoneMatch, current)) ||
        (pre.ifMatch !== null && !matchesIfMatch(pre.ifMatch, current))
    );
}

export function computeResourceEtag(bytes: Uint8Array): string {
    return new Bun.CryptoHasher('sha256').update(bytes).digest('hex');
}

// The terms both DAV protocols carry a precondition element for: bytes that do not parse, a broken object, a foreign component.
export type InvalidReason = 'data' | 'object' | 'component';

// A null etag is a write not stored verbatim, which has no validator to hand back (RFC 4791 § 5.3.4). The id is read
// inside the lock, so a facade announcing from it cannot lose the event to a racing delete.
export type PutResourceResult =
    | { ok: true; id: string; etag: string | null; created: boolean; unchanged: boolean }
    | {
          ok: false;
          error: 'precondition' | 'uid-conflict' | 'invalid' | 'no-collection' | 'too-large' | 'quota';
          reason?: InvalidReason;
          message?: string;
          conflictUri?: string;
      };

// The id is the row the delete removed, read inside the lock, for the announcement the facade makes after it.
export type DeleteResourceResult = { ok: true; id: string } | { ok: false; error: 'not-found' | 'precondition' };
