import type { QueryClient } from '@tanstack/react-query';

export const adminKeys = {
    all: ['admin'] as const,
    org: (orgId: string) => [...adminKeys.all, orgId] as const,
    members: (orgId: string) => [...adminKeys.org(orgId), 'members'] as const,
    teams: (orgId: string) => [...adminKeys.org(orgId), 'teams'] as const,
    // Users come from a server-wide admin endpoint (not org-scoped), so no orgId slot.
    users: () => [...adminKeys.all, 'users'] as const,
    usersList: () => [...adminKeys.users(), 'list'] as const,
    usersUsage: () => [...adminKeys.users(), 'usage'] as const,
    guests: () => [...adminKeys.users(), 'guest'] as const,
    setupStatus: () => [...adminKeys.all, 'setup-status'] as const,
};

// Waitlist is server-wide (home-independent route), so keys have no ownerId level.
export const waitlistKeys = {
    all: ['waitlist'] as const,
    entries: (status?: string) => [...waitlistKeys.all, 'entries', status ?? 'all'] as const,
};

export function invalidateWaitlistEntries(queryClient: QueryClient) {
    queryClient.invalidateQueries({ queryKey: waitlistKeys.all });
}

export function invalidateAdminUsers(queryClient: QueryClient): void {
    queryClient.invalidateQueries({ queryKey: adminKeys.users() });
}

export function invalidateAdminMembers(queryClient: QueryClient, organizationId: string): void {
    queryClient.invalidateQueries({ queryKey: adminKeys.members(organizationId) });
}

export function invalidateAdminTeams(queryClient: QueryClient, organizationId: string): void {
    queryClient.invalidateQueries({ queryKey: adminKeys.teams(organizationId) });
}
