import { validateEmailAddress } from './email';

export type ParsedContactInput = { email: string; displayName: string } | null;

export function parseContactInput(value: string): ParsedContactInput {
    const emailMatch = value.match(/<(.+)>/);

    if (emailMatch) {
        const email = emailMatch[1].toLowerCase();
        if (!validateEmailAddress(email)) return null;
        const displayName = value.split('<')[0].trim();
        return { email, displayName };
    }

    if (validateEmailAddress(value)) {
        const email = value.trim().toLowerCase();
        return { email, displayName: email.split('@')[0] };
    }

    return null;
}
