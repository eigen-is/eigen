// The guards a route calls before it acts. requireSelf, requireAdmin, requireTeamAccess and the like throw
// a 403 ApiError when the caller may not do this. requireLocalhost admits only callers on a trusted network,
// such as the mail containers that call the internal routes directly. clientIpKey is the one way to read
// the real client IP behind Caddy, which the server's own rate limits key on.

import { isMailAppEnabled } from '../config/env';
import { ApiError } from '../core/errors';
import type { User } from '../user';
import { getMemberships, getOrgRole, isGuest } from '../user';
import { isIpTrusted } from './trusted-networks';

type RequestServer = { requestIP(req: Request): { address: string } | null } | null;

// The real client IP behind Caddy, the one key every rate limit uses. Caddy overwrites X-Real-IP and
// X-Forwarded-For on proxied routes, so a client cannot fake them. On those routes the socket peer is only
// the proxy. A bridge caller, such as Postfix or Dovecot, connects directly, so its socket peer is the key.
// A request with no server, as app.handle() sends in a test, is 'unknown'.
export function clientIpKey(request: Request, server: RequestServer): string {
    return (
        request.headers.get('x-real-ip') ??
        request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ??
        server?.requestIP(request)?.address ??
        'unknown'
    );
}

export function requireLocalhost(request: Request, server: RequestServer): void {
    // Caddy already answers these routes with a 404 at the edge. This is a second guard behind it. A real
    // bridge caller, such as Postfix or Dovecot, connects directly and sets no proxy headers. Every request
    // Caddy proxies carries them, so it is refused, even though Caddy's own address is trusted.
    if (request.headers.has('x-real-ip') || request.headers.has('x-forwarded-for')) {
        throw new ApiError(403, 'Access denied: localhost only');
    }
    const ip = server?.requestIP(request)?.address;
    // No address lets the request through. A test's app.handle() has no server, and requestIP() is null once the
    // peer's socket is gone.
    if (!ip) return;
    if (!isIpTrusted(ip)) {
        throw new ApiError(403, 'Access denied: localhost only');
    }
}

export function requireSelf(ownerId: string, userId: string): void {
    if (ownerId !== userId) {
        throw new ApiError(403, 'Access denied: ownerId does not match authenticated user');
    }
}

export function requireNonGuest(user: Pick<User, 'role'>): void {
    if (isGuest(user)) {
        throw new ApiError(403, 'Guests cannot access this resource');
    }
}

export function requireMailEnabled(): void {
    if (!isMailAppEnabled()) throw new ApiError(403, 'Mail is turned off on this server');
}

export async function requireTeamAccess(userId: string, teamId: string): Promise<'admin' | 'member'> {
    const role = await getOrgRole(userId);
    if (role === 'admin' || role === 'owner') return 'admin';
    const memberships = await getMemberships(userId);
    if (!memberships.teamIds.includes(teamId)) throw new ApiError(403, 'Not a member of this team');
    return 'member';
}

export async function requireTeamAdmin(userId: string, teamId: string): Promise<void> {
    const access = await requireTeamAccess(userId, teamId);
    if (access !== 'admin') throw new ApiError(403, 'Admin or owner role required');
}

export async function requireAdmin(userId: string): Promise<void> {
    const role = await getOrgRole(userId);
    if (role !== 'admin' && role !== 'owner') throw new ApiError(403, 'Admin or owner role required');
}

export async function requireOwner(userId: string): Promise<void> {
    if ((await getOrgRole(userId)) !== 'owner') throw new ApiError(403, 'Only the server owner can do this');
}
