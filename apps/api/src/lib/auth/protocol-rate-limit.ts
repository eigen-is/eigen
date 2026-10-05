import { ApiError } from '../core/errors';
import { WindowLimiter } from '../core/window-limiter';

// FAILURE limiter for protocol Basic auth (IMAP/CalDAV/WebDAV).
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
// ages out — the accepted fail2ban tradeoff, and app-password clients are immune.

const WINDOW_MS = 15 * 60 * 1000;
const emailFailures = new WindowLimiter(WINDOW_MS, 10);
const ipFailures = new WindowLimiter(WINDOW_MS, 50);

// Called at the START of every attempt — refuse before doing any credential work.
export function checkProtocolAuthLimit(email: string, ip?: string): void {
    if (emailFailures.isFull(email.toLowerCase()) || (ip && ipFailures.isFull(ip))) {
        throw new ApiError(429, 'Too many failed authentication attempts — try again later');
    }
}

// Called at each 401 throw site.
export function recordProtocolAuthFailure(email: string, ip?: string): void {
    emailFailures.record(email.toLowerCase());
    if (ip) ipFailures.record(ip);
}

// Called on a successful auth: a proven-real credential clears its own EMAIL bucket (unlocking the
// account's other clients). The IP bucket is deliberately left to age out — see the header note.
export function clearProtocolAuthFailures(email: string): void {
    emailFailures.release(email.toLowerCase());
}

export function _resetProtocolAuthLimitForTests(): void {
    emailFailures.clear();
    ipFailures.clear();
}

export function _protocolAuthLimitSizesForTests(): { emails: number; ips: number } {
    return { emails: emailFailures.size, ips: ipFailures.size };
}
