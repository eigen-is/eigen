import { getMemberships, getOrgRole } from '../user';
import { ApiError } from './errors';

function ipv4ToNumber(ip: string): number {
    return ip.split('.').reduce((acc, octet) => (acc << 8) + parseInt(octet, 10), 0) >>> 0;
}

function normalizeIp(ip: string): string {
    return ip.startsWith('::ffff:') ? ip.slice(7) : ip;
}

function matchesCidr(ip: string, entry: string): boolean {
    const normalized = normalizeIp(ip);

    if (!entry.includes('/')) return normalized === entry || ip === entry;

    const [network, prefixStr] = entry.split('/');
    const prefix = parseInt(prefixStr, 10);
    // Only handle IPv4 CIDRs (sufficient for Docker bridge + localhost)
    if (!network.includes('.') || !normalized.includes('.')) return false;

    const mask = prefix === 0 ? 0 : (~0 << (32 - prefix)) >>> 0;
    return (ipv4ToNumber(normalized) & mask) === (ipv4ToNumber(network) & mask);
}

const DEFAULT_TRUSTED = '127.0.0.0/8,::1';

export function isIpTrusted(ip: string): boolean {
    const networks = (process.env['TRUSTED_NETWORKS'] || DEFAULT_TRUSTED).split(',');
    return networks.some((entry) => matchesCidr(ip, entry.trim()));
}

type RequestServer = { requestIP(req: Request): { address: string } | null } | null;

// One source of truth for the real client IP behind Caddy, which overwrites X-Real-IP /
// X-Forwarded-For with the true client on proxied routes (not spoofable). The socket peer is
// only the proxy — fall back to it for direct bridge callers (Postfix/Dovecot) and to 'unknown'
// with no server (tests). Every rate-limit / abuse key routes through here; don't re-derive inline.
export function clientIpKey(request: Request, server: RequestServer): string {
    return (
        request.headers.get('x-real-ip') ??
        request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ??
        server?.requestIP(request)?.address ??
        'unknown'
    );
}

export function requireLocalhost(request: Request, server: RequestServer): void {
    // Belt-and-suspenders with the Caddyfile edge 404: a genuine bridge caller (Postfix/Dovecot)
    // connects directly and sets no proxy headers, but every Caddy-proxied request carries
    // X-Real-IP / X-Forwarded-For — reject those even though Caddy's socket peer is trusted.
    if (request.headers.has('x-real-ip') || request.headers.has('x-forwarded-for')) {
        throw new ApiError(403, 'Access denied: localhost only');
    }
    const ip = server?.requestIP(request)?.address;
    if (!ip) return; // No server (e.g., tests using app.handle()) — allow
    if (!isIpTrusted(ip)) {
        throw new ApiError(403, 'Access denied: localhost only');
    }
}

export function requireSelf(ownerId: string, userId: string): void {
    if (ownerId !== userId) {
        throw new ApiError(403, 'Access denied: ownerId does not match authenticated user');
    }
}

export function requireNonGuest(user: { role?: string | null }): void {
    if (user.role === 'guest') {
        throw new ApiError(403, 'Guests cannot access this resource');
    }
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
