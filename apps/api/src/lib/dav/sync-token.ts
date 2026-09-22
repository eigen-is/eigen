import { davError } from './xml';

// Generation-stamped, so a rebuilt index invalidates every outstanding token; emit and parse sit together or drift.
export const formatSyncToken = (collection: { syncGen: number; ctag: number }) =>
    `urn:eigen:sync:${collection.syncGen}-${collection.ctag}`;

export function parseSyncToken(token: string): { gen: number; since: number } | null {
    const m = /^urn:eigen:sync:(\d+)-(\d+)$/.exec(token);
    return m ? { gen: Number(m[1]), since: Number(m[2]) } : null;
}

// Clients key their full RFC 6578 resync on this 403, sabre's status (RFC 3253 § 1.6 marshals preconditions as 403).
export const invalidSyncToken = () => davError(403, '<D:valid-sync-token/>');
