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

export function requireLocalhost(
    request: Request,
    server: { requestIP(req: Request): { address: string } | null } | null,
): void {
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
