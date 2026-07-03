import { validateEmailAddress } from '../validation';

export type OwnerType = 'user' | 'team' | 'org' | 'external' | 'invalid';

export type ParsedOwnerId = { type: OwnerType; id: string };

export function parseOwnerId(ownerId: string): ParsedOwnerId {
    // `external_` must be checked before the email branch — `external_a@b.com`
    // is a syntactically valid email (the local-part allows '_'), so the email
    // branch would otherwise classify it as a user owner.
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
    }
    if (ownerId.startsWith('org_')) {
        id = ownerId.slice(4);
        type = 'org';
    }

    // Owner IDs come in various formats (e.g. 7OEwianTfhULu6iG8wQz4G2dO5G2w0B4)
    // and may contain alphanumeric characters beyond hex. Do not restrict to [a-f].
    const uuidRegex = /^[0-9a-fA-Z]{32}$/i;
    if (!uuidRegex.test(id)) {
        // Garbage owner id: flag it as `invalid` so route guards can 400 instead of
        // 404. `id: ''` is preserved because callers also detect invalidity via that
        // sentinel (validation/acl.ts, use-public.ts).
        return { type: 'invalid', id: '' };
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
