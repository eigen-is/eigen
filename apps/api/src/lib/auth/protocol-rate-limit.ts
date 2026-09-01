import { ApiError } from '../core/errors';

// In-memory sliding-window FAILURE limiter for protocol Basic auth (IMAP/CalDAV/WebDAV).
// verifyProtocolAuth calls better-auth's signInEmail/verifyApiKey directly, bypassing the HTTP
// rate-limit middleware, and the apiKey plugin has its own rate limit disabled — so the public
// /dav + /webdav surface is otherwise an unlimited online password/app-password guessing oracle.
//
// We count FAILURES only. CalDAV/WebDAV/IMAP clients re-authenticate with Basic auth on every poll,
// so throttling *all* attempts (the way otp-rate-limit does) would lock out legit high-frequency
// clients and whole NAT'd offices. A run of failures is the brute-force signal; a success on an
// email clears that email's bucket, so a client polling with a valid credential never accumulates
// toward its own cap. The per-IP bucket is only aged out by the window, never cleared on success
// (see clearProtocolAuthFailures) — otherwise an attacker holding one valid account could spray
// guesses across many emails, then authenticate once to wipe the per-IP counter and repeat.
// verifyProtocolAuth checks a valid app password BEFORE consulting this limiter, so a valid
// credential is never refused by a saturated bucket; the cap only gates the expensive scrypt
// primary-password path. The residual: a non-2FA account whose clients auth by primary password
// only (no app password) can, worst case, have that path 429'd by a targeted flood until the window
// ages out — the accepted fail2ban tradeoff, and app-password clients are immune. State is process-
// local — fine while Eigen runs as a single API process; swap to a DB-backed store behind these
// signatures if we shard.

const WINDOW_MS = 15 * 60 * 1000;
const MAX_FAILURES_PER_EMAIL = 10;
const MAX_FAILURES_PER_IP = 50;
// A map only prunes the keys an attempt touches, so a spray across thousands of addresses leaves a
// dead key each. Past this size every recorded failure walks the whole map and drops what aged out:
// a few thousand comparisons, on a path that otherwise does scrypt work. No honest deployment has
// this many distinct failing emails or client IPs inside one window.
const SWEEP_ABOVE_KEYS = 2000;

const emailFailures = new Map<string, number[]>();
const ipFailures = new Map<string, number[]>();

function getPruned(buckets: Map<string, number[]>, key: string, now: number): number[] {
    return (buckets.get(key) ?? []).filter((t) => now - t < WINDOW_MS);
}

function persist(buckets: Map<string, number[]>, key: string, fresh: number[]): void {
    if (fresh.length === 0) buckets.delete(key);
    else buckets.set(key, fresh);
}

// Timestamps go in oldest-first, so the last one dates the whole bucket.
function sweep(buckets: Map<string, number[]>, now: number): void {
    if (buckets.size <= SWEEP_ABOVE_KEYS) return;
    for (const [key, times] of buckets) {
        if (now - times[times.length - 1] >= WINDOW_MS) buckets.delete(key);
    }
}

// Called at the START of every attempt — refuse before doing any credential work. Pruning here
// (and persisting the result) lets an aged-out bucket clear itself even on the throttled path.
export function checkProtocolAuthLimit(email: string, ip?: string): void {
    const now = Date.now();
    const emailKey = email.toLowerCase();

    const emailFresh = getPruned(emailFailures, emailKey, now);
    persist(emailFailures, emailKey, emailFresh);
    if (emailFresh.length >= MAX_FAILURES_PER_EMAIL) {
        throw new ApiError(429, 'Too many failed authentication attempts — try again later');
    }

    if (ip) {
        const ipFresh = getPruned(ipFailures, ip, now);
        persist(ipFailures, ip, ipFresh);
        if (ipFresh.length >= MAX_FAILURES_PER_IP) {
            throw new ApiError(429, 'Too many failed authentication attempts — try again later');
        }
    }
}

// Called at each 401 throw site.
export function recordProtocolAuthFailure(email: string, ip?: string): void {
    const now = Date.now();
    const emailKey = email.toLowerCase();
    const emailFresh = getPruned(emailFailures, emailKey, now);
    emailFresh.push(now);
    emailFailures.set(emailKey, emailFresh);

    if (ip) {
        const ipFresh = getPruned(ipFailures, ip, now);
        ipFresh.push(now);
        ipFailures.set(ip, ipFresh);
    }

    sweep(emailFailures, now);
    sweep(ipFailures, now);
}

// Called on a successful auth: a proven-real credential clears its own EMAIL bucket (unlocking the
// account's other clients). The IP bucket is deliberately left to age out — see the header note.
export function clearProtocolAuthFailures(email: string): void {
    emailFailures.delete(email.toLowerCase());
}

export function _resetProtocolAuthLimitForTests(): void {
    emailFailures.clear();
    ipFailures.clear();
}

export function _protocolAuthLimitSizesForTests(): { emails: number; ips: number } {
    return { emails: emailFailures.size, ips: ipFailures.size };
}
