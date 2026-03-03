export const peopleKeys = {
    all: ['people'] as const,
    members: () => [...peopleKeys.all, 'members'] as const,
    teams: () => [...peopleKeys.all, 'teams'] as const,
    teamMembers: (teamId: string) => [...peopleKeys.all, 'team-members', teamId] as const,
    activeMember: () => [...peopleKeys.all, 'active-member'] as const,
}
