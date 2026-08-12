export const adminKeys = {
    all: ['admin'] as const,
    org: (orgId: string) => [...adminKeys.all, orgId] as const,
    members: (orgId: string) => [...adminKeys.org(orgId), 'members'] as const,
    teams: (orgId: string) => [...adminKeys.org(orgId), 'teams'] as const,
    // Users come from a server-wide admin endpoint (not org-scoped), so no orgId slot.
    users: () => [...adminKeys.all, 'users'] as const,
    usersFiltered: (filter: 'guest' | 'orphan') => [...adminKeys.users(), filter] as const,
    setupStatus: () => ['setup-status'] as const,
};
