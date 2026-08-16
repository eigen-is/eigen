import type { AddressObject, EmailAddress } from '@workspace/lib/types/mail';

export type RecipientField = 'to' | 'cc' | 'bcc';

export type CanonicalRecipient = { name: string; address: string; field: RecipientField };

// Flattens RFC 2822 address groups (`Team: a@x, b@x;`) into their leaf members, dropping the bare
// group containers, which carry a name but no address. Recurses so nested groups are fully expanded.
export function flattenAddresses(value: EmailAddress[] | undefined): { name: string; address: string }[] {
    const flat: { name: string; address: string }[] = [];
    for (const entry of value ?? []) {
        if (entry.group) flat.push(...flattenAddresses(entry.group));
        if (entry.address) flat.push({ name: entry.name || '', address: entry.address });
    }
    return flat;
}

// Flattens to/cc/bcc into one ordered list of unique recipients: iterate to > cc > bcc so a
// first-wins, case-insensitive dedupe keeps the strongest field (an address in both To and Bcc
// classifies as To). Pure — no validation, no caps, no self-exclusion; callers layer those on.
// Shared by the send-path canonicaliser (apps/api) and the compose share-and-send preview
// (apps/mail) so the dialog's grant set matches exactly what the server will grant.
export function canonicalRecipients(draft: {
    to?: AddressObject;
    cc?: AddressObject;
    bcc?: AddressObject;
}): CanonicalRecipient[] {
    const recipients: CanonicalRecipient[] = [];
    const seen = new Set<string>();

    for (const field of ['to', 'cc', 'bcc'] as const) {
        for (const { name, address } of flattenAddresses(draft[field]?.value)) {
            const key = address.toLowerCase();
            if (seen.has(key)) continue;
            seen.add(key);
            recipients.push({ name, address, field });
        }
    }

    return recipients;
}
