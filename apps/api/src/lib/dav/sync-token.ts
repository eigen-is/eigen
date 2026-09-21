import { davError } from './xml';

// The RFC 6578 sync token both DAV collections hand out, and the one answer a token they cannot honor gets.

// Generation-stamped, so a rebuilt index invalidates every outstanding token. The only two sites allowed to
// spell the grammar — emit/parse drift would send every client into a permanent full-resync loop.
export const formatSyncToken = (collection: { syncGen: number; ctag: number }) =>
    `urn:eigen:sync:${collection.syncGen}-${collection.ctag}`;

export function parseSyncToken(token: string): { gen: number; since: number } | null {
    const m = /^urn:eigen:sync:(\d+)-(\d+)$/.exec(token);
    return m ? { gen: Number(m[1]), since: Number(m[2]) } : null;
}

// RFC 6578 recovery: a token the collection can't honor (stale generation, future ctag, or malformed) forces
// the client to redo the full comparison. sabre answers 403 (InvalidSyncToken extends Forbidden) with
// D:valid-sync-token; RFC 3253 § 1.6 marshals precondition failures as 403, and clients key full resync on it.
export const invalidSyncToken = () => davError(403, '<D:valid-sync-token/>');
