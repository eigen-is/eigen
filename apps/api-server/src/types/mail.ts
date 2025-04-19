import type {
    Email as EmailType,
    EmailSummary as EmailSummaryType,
    MaildirMailbox as MaildirMailboxType
} from "../lib/mail/mailtypes";
import type {AddressObject} from "../lib/mail/mail-parser";

export type Email = EmailType;
export type EmailSummary = EmailSummaryType;
export type MaildirMailbox = MaildirMailboxType;

/**
 * EmailDraft extends Email type with guaranteed AddressObject type for to, cc, bcc fields
 * This makes these fields fully type-safe when working with drafts
 */
export type EmailDraft = Omit<Email, 'to' | 'cc' | 'bcc'> & {
    // These fields are guaranteed to be AddressObject (not arrays) in drafts
    to?: AddressObject;
    cc?: AddressObject;
    bcc?: AddressObject;
};
