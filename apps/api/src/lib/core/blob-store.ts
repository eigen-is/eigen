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

// A rebuild that lost the stored value would reissue its generation, so the wall clock in seconds floors it.
export function nextSyncGen(stored: number | undefined, now: number): number {
    return Math.max((stored ?? 0) + 1, Math.floor(now / 1000));
}

export function computeResourceEtag(bytes: Uint8Array): string {
    return new Bun.CryptoHasher('sha256').update(bytes).digest('hex');
}

// The terms both DAV protocols carry a precondition element for: bytes that do not parse, a broken object, a foreign component.
export type InvalidReason = 'data' | 'object' | 'component';

// A client-caused failure is a value, not a throw; a null etag is a write not stored verbatim, which has no validator to hand back (RFC 4791 § 5.3.4).
export type PutResourceResult =
    | { ok: true; etag: string | null; created: boolean }
    | {
          ok: false;
          error: 'precondition' | 'uid-conflict' | 'invalid' | 'no-collection' | 'too-large' | 'quota';
          reason?: InvalidReason;
          message?: string;
          conflictUri?: string;
      };

export type DeleteResourceResult = { ok: true } | { ok: false; error: 'not-found' | 'precondition' };

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
