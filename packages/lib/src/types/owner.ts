import { validateEmailAddress } from '../validation';

export type OwnerType = 'user' | 'team' | 'org';

export type ParsedOwnerId = { type: OwnerType; id: string };

export function parseOwnerId(ownerId: string): ParsedOwnerId {
    let id = ownerId,
        type: OwnerType = 'user';

    if (validateEmailAddress(ownerId)) {
        return { type: 'user', id: ownerId.toLowerCase() };
    }

    if (ownerId.startsWith('team_')) {
        id = ownerId.slice(5);
        type = 'team';
    }
    if (ownerId.startsWith('org_')) {
        id = ownerId.slice(4);
        type = 'org';
    }

    // Owner IDs come in various formats (e.g. 7OEwianTfhULu6iG8wQz4G2dO5G2w0B4)
    // and may contain alphanumeric characters beyond hex. Do not restrict to [a-f].
    const uuidRegex = /^[0-9a-fA-Z]{32}$/i;
    if (!uuidRegex.test(id)) {
        return { type: 'user', id: '' };
    }

    return { id, type };
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
