import { ApiError } from '../core/errors';

// In-memory sliding-window limiter for /guest-auth/request-otp. Prevents the open
// signup endpoint from being weaponized as a free OTP-blaster: each call costs one
// slot in the email bucket and one in the IP bucket, both expire after WINDOW_MS.
// A successful sign-in hands its slots back, so only requests that never prove the
// mailbox count; the per-IP cap leaves room for an office of guests behind one address.
// State is process-local — fine while Eigen runs as a single API process. Swap to
// a DB-backed store behind the same `checkOtpRateLimit` signature if we ever shard.

const WINDOW_MS = 60 * 60 * 1000;
export const MAX_OTP_REQUESTS_PER_EMAIL = 10;
export const MAX_OTP_REQUESTS_PER_IP = 100;
export const MAX_OTP_GUESSES = 10;

type Hit = { at: number; email: string };

const emailHits = new Map<string, Hit[]>();
const ipHits = new Map<string, Hit[]>();
const guesses = new Map<string, { count: number; expiresAt: number }>();

function getPruned(buckets: Map<string, Hit[]>, key: string, now: number): Hit[] {
    return (buckets.get(key) ?? []).filter((hit) => now - hit.at < WINDOW_MS);
}

function persist(buckets: Map<string, Hit[]>, key: string, fresh: Hit[]): void {
    if (fresh.length === 0) buckets.delete(key);
    else buckets.set(key, fresh);
}

export function checkOtpRateLimit(email: string, ip: string): void {
    const now = Date.now();
    const emailKey = email.toLowerCase();

    const emailFresh = getPruned(emailHits, emailKey, now);
    const ipFresh = getPruned(ipHits, ip, now);

    if (emailFresh.length >= MAX_OTP_REQUESTS_PER_EMAIL) {
        persist(emailHits, emailKey, emailFresh);
        persist(ipHits, ip, ipFresh);
        throw new ApiError(429, 'Too many requests for this email — try again later');
    }
    if (ipFresh.length >= MAX_OTP_REQUESTS_PER_IP) {
        persist(emailHits, emailKey, emailFresh);
        persist(ipHits, ip, ipFresh);
        throw new ApiError(429, 'Too many requests from this network — try again later');
    }

    const hit = { at: now, email: emailKey };
    emailFresh.push(hit);
    ipFresh.push(hit);
    emailHits.set(emailKey, emailFresh);
    ipHits.set(ip, ipFresh);
}

// A verified sign-in proves the mailbox, so the requests that led to it stop counting.
export function refundOtpRequests(email: string, ip: string): void {
    const emailKey = email.toLowerCase();
    emailHits.delete(emailKey);
    persist(
        ipHits,
        ip,
        (ipHits.get(ip) ?? []).filter((hit) => hit.email !== emailKey),
    );
}

// Counts one guess against the email's live code; false once the code is out of guesses.
export function countOtpGuess(email: string, codeExpiresAt: Date): boolean {
    const now = Date.now();
    for (const [key, entry] of guesses) {
        if (entry.expiresAt <= now) guesses.delete(key);
    }
    const key = email.toLowerCase();
    const entry = guesses.get(key) ?? { count: 0, expiresAt: codeExpiresAt.getTime() };
    entry.count++;
    guesses.set(key, entry);
    return entry.count <= MAX_OTP_GUESSES;
}

export function resetOtpGuesses(email: string): void {
    guesses.delete(email.toLowerCase());
}

export function _resetOtpRateLimitForTests(): void {
    emailHits.clear();
    ipHits.clear();
    guesses.clear();
}
