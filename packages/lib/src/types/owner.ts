import { validateEmailAddress } from '../validation';

export type OwnerType = 'user' | 'team' | 'org' | 'external';

export type ParsedOwnerId = { type: OwnerType; id: string };

// Owner IDs come in three shapes:
//   - 32-char alphanumeric (better-auth's `generateId`) for users/teams/orgs
//   - email addresses (used as the user-facing id of a user owner)
//   - `external_<email>` for non-Eigen organizers (iMIP)
//
// Throws on garbage input. Silent fallthrough used to mask bugs (e.g. guest user
// ids that contained '_' from `generateRandomString`'s base64-url alphabet) by
// turning every owner-scoped lookup into a vague 404.
const ID_REGEX = /^[0-9A-Za-z]{32}$/;

export function parseOwnerId(ownerId: string): ParsedOwnerId {
    // `external_` must be checked before the email regex — `external_a@b.com`
    // is a syntactically valid email (the local-part allows '_'), so the email
    // branch would otherwise eat it.
    if (ownerId.startsWith('external_')) {
        return { type: 'external', id: ownerId.slice(9) };
    }

    if (validateEmailAddress(ownerId)) {
        return { type: 'user', id: ownerId.toLowerCase() };
    }

    let id = ownerId;
    let type: OwnerType = 'user';

    if (ownerId.startsWith('team_')) {
        id = ownerId.slice(5);
        type = 'team';
    } else if (ownerId.startsWith('org_')) {
        id = ownerId.slice(4);
        type = 'org';
    }

    if (!ID_REGEX.test(id)) {
        throw new Error(`Invalid ownerId format: ${JSON.stringify(ownerId)}`);
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

export function externalOwnerId(email: string): string {
    return `external_${email}`;
}

export function isExternalOwnerId(ownerId: string): boolean {
    return ownerId.startsWith('external_');
}
