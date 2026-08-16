import { type CanonicalRecipient, canonicalRecipients } from '@workspace/lib/mail/addresses';
import type { AddressObject } from '@workspace/lib/types/mail';
import { ApiError } from '../core/errors';

export const MAX_SEND_RECIPIENTS = 100;
export const MAX_SEND_REFERENCES = 20;
// Past this much attachment fan-out the send drops to one bare-link copy instead of personalising.
export const MAX_PERSONALISED_SEND_BYTES = 20 * 1024 * 1024;

export type { CanonicalRecipient };

// Send-path wrapper over the shared canonicaliser: same flatten + first-wins dedupe the compose
// preview uses, plus the '@' check and recipient cap the send path enforces.
export function canonicalizeRecipients(draft: {
    to?: AddressObject;
    cc?: AddressObject;
    bcc?: AddressObject;
}): CanonicalRecipient[] {
    const recipients = canonicalRecipients(draft);

    for (const { address } of recipients) {
        // Minimal '@' check, not validateEmailAddress: its regex requires a dot in the domain,
        // which would 400 every `@localhost` recipient the current send path already accepts.
        if (!address.includes('@')) throw new ApiError(400, `Invalid recipient address: ${address}`);
    }

    if (recipients.length > MAX_SEND_RECIPIENTS) {
        throw new ApiError(400, `A message can have at most ${MAX_SEND_RECIPIENTS} recipients`);
    }

    return recipients;
}
