import { validateEmailAddress } from './email';

export type ParsedContactInput = { email: string; displayName: string } | null;

/**
 * Parse a contact-input string into `{ email, displayName }`.
 * Accepts either `Display Name <email@example.com>` or a bare email.
 * Returns null for anything that isn't a valid email.
 */
export function parseContactInput(value: string): ParsedContactInput {
    const emailMatch = value.match(/<(.+)>/);

    if (emailMatch) {
        const email = emailMatch[1].toLowerCase();
        const displayName = value.split('<')[0].trim();
        return { email, displayName };
    }

    if (validateEmailAddress(value)) {
        const email = value.trim().toLowerCase();
        return { email, displayName: email.split('@')[0] };
    }

    return null;
}
