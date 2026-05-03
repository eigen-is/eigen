import { ApiError } from '../core/errors';

// In-memory sliding-window limiter for /guest-auth/request-otp. Prevents the open
// signup endpoint from being weaponized as a free OTP-blaster: each call costs one
// slot in the email bucket and one in the IP bucket, both expire after WINDOW_MS.
// State is process-local — fine while Eigen runs as a single API process. Swap to
// a DB-backed store behind the same `checkOtpRateLimit` signature if we ever shard.

const WINDOW_MS = 60 * 60 * 1000;
const MAX_PER_EMAIL = 3;
const MAX_PER_IP = 10;

const emailHits = new Map<string, number[]>();
const ipHits = new Map<string, number[]>();

function getPruned(buckets: Map<string, number[]>, key: string, now: number): number[] {
    return (buckets.get(key) ?? []).filter((t) => now - t < WINDOW_MS);
}

function persist(buckets: Map<string, number[]>, key: string, fresh: number[]): void {
    if (fresh.length === 0) buckets.delete(key);
    else buckets.set(key, fresh);
}

export function checkOtpRateLimit(email: string, ip: string): void {
    const now = Date.now();
    const emailKey = email.toLowerCase();

    const emailFresh = getPruned(emailHits, emailKey, now);
    const ipFresh = getPruned(ipHits, ip, now);

    if (emailFresh.length >= MAX_PER_EMAIL) {
        persist(emailHits, emailKey, emailFresh);
        persist(ipHits, ip, ipFresh);
        throw new ApiError(429, 'Too many requests for this email — try again later');
    }
    if (ipFresh.length >= MAX_PER_IP) {
        persist(emailHits, emailKey, emailFresh);
        persist(ipHits, ip, ipFresh);
        throw new ApiError(429, 'Too many requests from this network — try again later');
    }

    emailFresh.push(now);
    ipFresh.push(now);
    emailHits.set(emailKey, emailFresh);
    ipHits.set(ip, ipFresh);
}

export function _resetOtpRateLimitForTests(): void {
    emailHits.clear();
    ipHits.clear();
}
