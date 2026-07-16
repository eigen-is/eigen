import { ApiError } from '../core/errors';

// In-memory sliding-window limiter for the public GET /p/demo/enter route. That route is
// unauthenticated and runs two scrypt ops per hit (password re-derive + signInEmail), so the
// loose global limiter (1000/60s) isn't tight enough — cap it per client IP. State is
// process-local (fine for a single-process demo box); Caddy sets the real client IP in
// X-Real-IP, so the key isn't spoofable. Mirrors otp-rate-limit.ts (IP bucket only).

const WINDOW_MS = 60 * 1000;
const MAX_PER_IP = 10;

const ipHits = new Map<string, number[]>();

export function checkDemoRateLimit(ip: string): void {
    const now = Date.now();
    const fresh = (ipHits.get(ip) ?? []).filter((t) => now - t < WINDOW_MS);
    if (fresh.length >= MAX_PER_IP) {
        ipHits.set(ip, fresh);
        throw new ApiError(429, 'Too many requests from this network — try again later');
    }
    fresh.push(now);
    ipHits.set(ip, fresh);
}
