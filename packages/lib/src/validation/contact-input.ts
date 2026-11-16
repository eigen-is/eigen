// Reads one person typed into a people field, either a bare address or "Name <address>", the form a picked
// suggestion arrives in. The pickers that add people one at a time, such as an event's guests or a share list, call it
// through their shared input hook.

import { validateEmailAddress } from './email';

export type ParsedContactInput = { email: string; displayName?: string } | null;

export function parseContactInput(value: string): ParsedContactInput {
    const emailMatch = value.match(/<(.+)>/);

    if (emailMatch) {
        const email = emailMatch[1].toLowerCase();
        if (!validateEmailAddress(email)) return null;
        const displayName = value.split('<')[0].trim();
        return { email, displayName: displayName || undefined };
    }

    if (validateEmailAddress(value)) {
        const email = value.trim().toLowerCase();
        return { email };
    }

    return null;
}
