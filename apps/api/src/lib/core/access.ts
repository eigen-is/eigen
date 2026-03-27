import {ApiError} from './errors';
import {getMemberships, getOrgRole} from '../user';

export function requireLocalhost(request: Request, server: { requestIP(req: Request): { address: string } | null } | null): void {
    const ip = server?.requestIP(request)?.address;
    if (!ip) return; // No server (e.g., tests using app.handle()) — allow
    if (ip !== '127.0.0.1' && ip !== '::1') {
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
