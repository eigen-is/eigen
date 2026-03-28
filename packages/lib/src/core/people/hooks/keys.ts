export const peopleKeys = {
    all: ['people'] as const,
    org: (orgId: string) => [...peopleKeys.all, orgId] as const,
    members: (orgId: string) => [...peopleKeys.org(orgId), 'members'] as const,
    teams: (orgId: string) => [...peopleKeys.org(orgId), 'teams'] as const,
    teamMembers: (orgId: string, teamId: string) => [...peopleKeys.org(orgId), 'team-members', teamId] as const,
    activeMember: () => [...peopleKeys.all, 'active-member'] as const,
};
