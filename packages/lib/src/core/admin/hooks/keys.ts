export const adminKeys = {
    all: ['admin'] as const,
    org: (orgId: string) => [...adminKeys.all, orgId] as const,
    members: (orgId: string) => [...adminKeys.org(orgId), 'members'] as const,
    teams: (orgId: string) => [...adminKeys.org(orgId), 'teams'] as const,
    teamMembers: (orgId: string, teamId: string) => [...adminKeys.org(orgId), 'team-members', teamId] as const,
    activeMember: () => [...adminKeys.all, 'active-member'] as const,
    setupStatus: () => ['setup-status'] as const,
};
