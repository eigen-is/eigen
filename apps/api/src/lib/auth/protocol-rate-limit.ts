// The limit on failed sign-ins over the mail and DAV protocols. verifyProtocolAuth checks passwords itself, outside
// better-auth's HTTP rate limit, so without this the protocol servers would take unlimited password guesses. Only
// failures count, per email and per IP, over a 15-minute window, because protocol clients sign in again on every
// poll and a limit on every attempt would lock out busy clients and offices behind one address.

import { ApiError } from '../core/errors';
import { WindowLimiter } from '../core/window-limiter';

const WINDOW_MS = 15 * 60 * 1000;
const emailFailures = new WindowLimiter(WINDOW_MS, 10);
const ipFailures = new WindowLimiter(WINDOW_MS, 50);

// Called before any password work, so a full bucket costs no hash.
export function checkProtocolAuthLimit(email: string, ip?: string): void {
    if (emailFailures.isFull(email.toLowerCase()) || (ip && ipFailures.isFull(ip))) {
        throw new ApiError(429, 'Too many failed authentication attempts — try again later');
    }
}

export function recordProtocolAuthFailure(email: string, ip?: string): void {
    emailFailures.record(email.toLowerCase());
    if (ip) ipFailures.record(ip);
}

// A success clears its email's bucket, so a polling client never fills its own. The IP bucket only ages out: if a
// success cleared it, one valid account could reset the count for guesses across many emails. A full bucket only
// blocks the account password, because verifyProtocolAuth accepts a valid app password first. One cost is accepted:
// a flood aimed at an account that uses its account password, and has no app password, locks that account's clients
// out until the window passes.
export function clearProtocolAuthFailures(email: string): void {
    emailFailures.release(email.toLowerCase());
}

export function _resetProtocolAuthLimitForTests(): void {
    emailFailures.clear();
    ipFailures.clear();
}
