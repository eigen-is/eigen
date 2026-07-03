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

export type MailFlag = 'seen' | 'replied' | 'flagged' | 'draft' | 'trashed' | 'forwarded';

// The swappable mail storage contract held by the Mail domain class (AUDIT_MAIL.md
// § Backend abstraction). Maildir (+ MailDB) is the only implementation today.
export interface MailStore {
    init(): Promise<void>;
    destruct(): Promise<void>;
    size(): Promise<number>;
    search(opts: MailSearchOptions): EmailSummary[];

    mailboxesList(): Promise<MaildirMailbox[]>;
    mailboxCreate(mailbox: string): Promise<void>;
    mailboxExists(mailbox: string): Promise<MaildirMailbox | false>;
    listMessages(mailbox: string): Promise<EmailSummary[]>;

    getSummary(messageId: string): EmailSummary | undefined;
    getMessage(messageId: string): Promise<Email | null>;
    getRawMessage(messageId: string): Promise<ArrayBuffer>;
    getAttachments(messageId: string): Promise<Attachment[]>;
    append(mailbox: string, message: Buffer): Promise<string>;
    delete(messageId: string): Promise<void>;
    move(messageId: string, targetMailbox: string): Promise<void>;
    setFlags(messageId: string, changes: Partial<Record<MailFlag, boolean>>): Promise<void>;

    readDraftMeta<T = Record<string, unknown>>(draftId: string): Promise<T | null>;
    deleteDraftMeta(draftId: string): Promise<void>;
    cleanupStaleDraftTemps(maxAgeMs?: number): Promise<void>;

    // Temporary residents until the draft machine and send pipeline move into Mail (steps 2c-2d).
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
