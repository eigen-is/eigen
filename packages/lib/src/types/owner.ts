export type OwnerType = 'user' | 'team' | 'org';

export type ParsedOwnerId = { type: OwnerType; id: string };

export function parseOwnerId(ownerId: string): ParsedOwnerId {
    if (ownerId.startsWith('team_')) return {type: 'team', id: ownerId.slice(5)};
    if (ownerId.startsWith('org_')) return {type: 'org', id: ownerId.slice(4)};
    return {type: 'user', id: ownerId};
}

export function userOwnerId(userId: string): string {
    return userId;
}

export function teamOwnerId(teamId: string): string {
    return `team_${teamId}`;
}

export function orgOwnerId(orgId: string): string {
    return `org_${orgId}`;
}
