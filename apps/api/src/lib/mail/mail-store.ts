import type {
    Attachment,
    DraftAttachmentUpload,
    Email,
    EmailDraft,
    EmailSummary,
    MaildirMailbox,
    NewDraft,
} from '@workspace/lib/types/mail';
import type { StorageFile } from '../storage';

export type DraftUpdateOptions = {
    tempAttachmentIds?: string[];
    keepAttachmentIndexes?: number[];
    forceFullSave?: boolean;
};

export type MailSearchOptions = {
    q: string;
    limit: number;
    mailboxes?: string[];
    from?: string;
    to?: string;
};

// The mail backend contract behind home.mail. Extracted from Maildir's public surface
// (AUDIT_MAIL.md § Backend abstraction); Maildir is the only implementation today.
export interface MailStore {
    init(): Promise<void>;
    destruct(): Promise<void>;
    size(): Promise<number>;
    search(opts: MailSearchOptions): EmailSummary[];

    mailboxesList(): Promise<MaildirMailbox[]>;
    mailboxCreate(mailbox: string): Promise<void>;
    mailboxExists(mailbox: string): Promise<MaildirMailbox | false>;
    mailboxDeliver(message: Buffer): Promise<string>;
    mailboxGet(mailbox: string): Promise<EmailSummary[]>;

    messageGet(messageId: string): Promise<Email | null>;
    messageGetFile(messageId: string): Promise<ArrayBuffer>;
    messageGetAttachment(messageId: string, index: number): Promise<Attachment>;
    messageGetAttachments(messageId: string): Promise<Attachment[]>;
    messageDelete(messageId: string): Promise<void>;
    messageMove(messageId: string, targetMailbox: string): Promise<void>;
    messageCopy(messageId: string, targetMailbox: string): Promise<void>;
    messageSetRead(messageId: string, read: boolean): Promise<void>;
    messageSetFlagged(messageId: string, flagged: boolean): Promise<void>;

    messageHandleDraft(email: NewDraft | EmailDraft, options?: DraftUpdateOptions): Promise<EmailDraft>;
    uploadDraftAttachment(request: Request, maxSize: number): Promise<DraftAttachmentUpload>;
    stageDriveAttachment(
        source: StorageFile,
        filename: string,
        contentType: string,
        maxSize: number,
    ): Promise<DraftAttachmentUpload>;
    messageSend(mail: NewDraft | EmailDraft): Promise<EmailDraft>;
}
