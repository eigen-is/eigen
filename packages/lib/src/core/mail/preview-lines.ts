// What a message says about itself where its own headers are silent or cut short, spelled once for the
// reader, the `.eml` quick look and the drive hero.
export const NO_SUBJECT = '(No subject)';

// The counted line an `.eml` preview ends on when the payload carries fewer parts than the message has.
export function remainingAttachmentsLine(remaining: number): string {
    return `and ${remaining} more attachment${remaining === 1 ? '' : 's'}`;
}
