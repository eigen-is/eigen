import type { AddressObject, EmailAddress } from '@workspace/lib/types/mail';
import { ApiError } from '../core/errors';

export const MAX_SEND_RECIPIENTS = 100;
export const MAX_SEND_REFERENCES = 20;

export type CanonicalRecipient = { name: string; address: string; field: 'to' | 'cc' | 'bcc' };

// Flattens RFC 2822 address groups (`Team: a@x, b@x;`) into their leaf members, dropping the bare
// group containers, which carry a name but no address.
export function flattenAddresses(value: EmailAddress[] | undefined, out: { name: string; address: string }[]): void {
    for (const entry of value ?? []) {
        if (entry.group) flattenAddresses(entry.group, out);
        if (entry.address) out.push({ name: entry.name || '', address: entry.address });
    }
}

export function canonicalizeRecipients(draft: {
    to?: AddressObject;
    cc?: AddressObject;
    bcc?: AddressObject;
}): CanonicalRecipient[] {
    const recipients: CanonicalRecipient[] = [];
    const seen = new Set<string>();

    // to > cc > bcc: iterate in precedence order so first-wins dedupe keeps the strongest field.
    for (const field of ['to', 'cc', 'bcc'] as const) {
        const flat: { name: string; address: string }[] = [];
        flattenAddresses(draft[field]?.value, flat);
        for (const { name, address } of flat) {
            // Minimal '@' check, not validateEmailAddress: its regex requires a dot in the domain,
            // which would 400 every `@localhost` recipient the current send path already accepts.
            if (!address.includes('@')) throw new ApiError(400, `Invalid recipient address: ${address}`);
            const key = address.toLowerCase();
            if (seen.has(key)) continue;
            seen.add(key);
            recipients.push({ name, address, field });
        }
    }

    if (recipients.length > MAX_SEND_RECIPIENTS) {
        throw new ApiError(400, `A message can have at most ${MAX_SEND_RECIPIENTS} recipients`);
    }

    return recipients;
}
