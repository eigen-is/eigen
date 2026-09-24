// Hard caps on one outgoing message. The reference cap is also enforced in the composer, so a
// 21st linked document is refused before it 422s every save; the recipient cap is a 400 at send.
export const MAX_SEND_RECIPIENTS = 100;
export const MAX_SEND_REFERENCES = 20;

// Length of the list preview (`EmailSummary.textShort`) as stored for drafts and as served by the list route.
export const MAIL_PREVIEW_CHARS = 200;

// One whole `.eml`, shared FE/BE: the preview guard and the import refuse a bigger file. The same 25 MiB
// a single outgoing attachment is capped at (config/enforcement.ts), which is what a message of this size
// would be made of — a separate fact, so a separate constant.
export const EML_MAX_BYTES = 25 * 1024 * 1024;

// The relay port when SMTP_RELAY_PORT names none: submission, which every relay offers.
export const DEFAULT_RELAY_PORT = 587;

// The system sender while the admin names none.
export function defaultSenderAddress(mailDomain: string): string {
    return `noreply@${mailDomain}`;
}
