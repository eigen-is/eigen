import {isEmailAddress} from "@workspace/ui/validation";

export type OwnerType = 'user' | 'team' | 'org';

export type ParsedOwnerId = { type: OwnerType; id: string };

export function parseOwnerId(ownerId: string): ParsedOwnerId {
    let id = ownerId, type: OwnerType = 'user';

    if (ownerId.startsWith('team_')) {
        id = ownerId.slice(5);
        type = 'team';
    }
    if (ownerId.startsWith('org_')) {
        id = ownerId.slice(4);
        type = 'org';
    }

    // check if id is valid uuid
    const uuidRegex = /^[0-9a-fA-Z]{32}$/i;
    if (!uuidRegex.test(id) && !(type === 'user' && isEmailAddress(ownerId))) {
        throw new Error(`Invalid ownerId: ${ownerId}`);
    }

    return {id, type};
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
