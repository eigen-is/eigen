import type { AttachmentReference } from '@workspace/lib/types/drive-reference';
import type {
    AddressObject,
    Attachment,
    DraftAttachmentUpload,
    Email,
    EmailSummary,
    MaildirMailbox,
} from '@workspace/lib/types/mail';
import type { FileSink } from 'bun';

export type MailSearchOptions = {
    q: string;
    limit: number;
    mailboxes?: string[];
    from?: string;
    to?: string;
};

// One entry per named, non-calendar part of a draft EML, under the part's raw index — the number a
// keep list addresses. An entry from a sidecar written before the index existed carries none, and
// sends the next save down the full path rather than guessing at positions.
export type DraftMetaAttachment = { filename: string; contentType: string; size: number; index?: number };

export type DraftMeta = {
    subject: string;
    to?: AddressObject;
    cc?: AddressObject;
    bcc?: AddressObject;
    text: string;
    // "Clean" body as typed by the user — without the reference-card HTML that the EML
    // on disk has baked in. Overlaid on messageGet so the compose view shows what the
    // user typed, not the rendered card block at the bottom.
    html: string;
    attachments: DraftMetaAttachment[];
    driveReferences?: AttachmentReference[];
    inReplyTo?: string;
    references?: string[] | string;
    lastFullSaveAt?: number;
};

export type MailFlag = 'seen' | 'replied' | 'flagged' | 'draft' | 'trashed' | 'forwarded';

// Change stream surfaced by the store's own discovery (sync + fs.watch today; JMAP push or
// IMAP IDLE for a remote backend). The Mail domain turns these into SSE + notifications.
export type MailStoreEvents = {
    received: (email: Email, isNew: boolean) => void;
    flagsChanged: (messageId: string, mailbox: string) => void;
    deleted: (messageId: string, mailbox: string) => void;
};

// The swappable mail storage contract held by the Mail domain class. MaildirStore
// (+ MailDB) is the only implementation today.
export interface MailStore {
    // Resolves true when a fresh (empty) store was created.
    init(events: MailStoreEvents): Promise<boolean>;
    watch(): Promise<void>;
    unwatch(): Promise<void>;
    destruct(): Promise<void>;
    size(): Promise<number>;
    search(opts: MailSearchOptions): EmailSummary[];

    mailboxesList(): Promise<MaildirMailbox[]>;
    mailboxCreate(mailbox: string): Promise<void>;
    mailboxExists(mailbox: string): Promise<MaildirMailbox | false>;
    listMessages(
        mailbox: string,
        opts: { limit: number; before?: { date: Date; id: string } },
    ): Promise<EmailSummary[]>;

    getSummary(messageId: string): EmailSummary | undefined;
    getMessage(messageId: string): Promise<Email | null>;
    getRawMessage(messageId: string): Promise<ArrayBuffer>;
    getAttachments(messageId: string): Promise<Attachment[]>;
    // skipSync: leave discovery to the next sync — welcome-mail seeding surfaces on first open.
    append(mailbox: string, message: Buffer, opts?: { skipSync?: boolean }): Promise<string>;
    // Writes raw draft bytes under existingId (or a fresh id), indexes them, returns the parsed result.
    saveDraft(raw: string, existingId?: string): Promise<Email>;
    delete(messageId: string): Promise<void>;
    move(messageId: string, targetMailbox: string): Promise<void>;
    setFlags(messageId: string, changes: Partial<Record<MailFlag, boolean>>): Promise<void>;
    // The one projection of a sidecar onto its index row: the fast save applies it beside the sidecar
    // write, and the Drafts sync re-applies it over a row rebuilt from the .eml that save left stale.
    applyDraftMeta(draftId: string, meta: DraftMeta): void;

    writeDraftMeta(draftId: string, meta: DraftMeta): Promise<void>;
    // A missing sidecar and one a crash tore both read as null; the caller falls back to the .eml.
    readDraftMeta(draftId: string): Promise<DraftMeta | null>;
    deleteDraftMeta(draftId: string): Promise<void>;
    listDraftMetaIds(): Promise<string[]>;

    persistDraftTemp(
        write: (writer: FileSink) => Promise<number>,
        filename: string,
        contentType: string,
    ): Promise<DraftAttachmentUpload>;
    readDraftTempFile(tempId: string): Promise<{ content: Buffer; filename: string; contentType: string } | null>;
    cleanupDraftTemp(tempId: string): Promise<void>;
    cleanupStaleDraftTemps(): Promise<void>;
}
