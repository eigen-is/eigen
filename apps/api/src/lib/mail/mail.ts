import type { DrivePath } from '@workspace/lib/types/drive';
import type { DraftAttachmentUpload, Email, EmailDraft, EmailSummary, NewDraft } from '@workspace/lib/types/mail';
import type { User } from 'better-auth/types';
import { processInboundImip } from '../calendar/imip';
import { getMailUploadMaxSize, getUploadMaxSize } from '../config/enforcement';
import { ApiError } from '../core/errors';
import { getSharedDrive } from '../drive';
import { getHome } from '../home';
import { getUserByEmail } from '../user/';
import { simpleParser } from './mail-parser';

async function getMailClient(user: User) {
    const home = await getHome(user.id);
    return home.mail;
}

export async function mailboxesList(user: User) {
    const mail = await getMailClient(user);
    return await mail.mailboxesList();
}

export async function mailboxGet(user: User, mailbox: string): Promise<EmailSummary[]> {
    const mail = await getMailClient(user);
    return await mail.mailboxGet(mailbox);
}

export async function mailboxCreate(user: User, mailbox: string) {
    const mail = await getMailClient(user);
    return await mail.mailboxCreate(mailbox);
}

export async function mailboxExists(user: User, mailbox: string) {
    const mail = await getMailClient(user);
    return await mail.mailboxExists(mailbox);
}

export async function mailboxDeliver(to: string, file: ArrayBuffer) {
    const user = await getUserByEmail(to);
    if (!user) {
        throw new ApiError(404, `Recipient '${to}' not found`);
    }
    const home = await getHome(user.id);
    const message = new TextDecoder().decode(new Uint8Array(file));
    const result = await home.mail.mailboxDeliver(message);

    // Process iMIP calendar attachments (blocking so event exists before client queries)
    try {
        const parsed = await simpleParser(message);
        const hasCalendar = parsed.attachments.some((a) => a.contentType.startsWith('text/calendar'));
        if (hasCalendar) {
            processInboundImip(home, parsed);
        }
    } catch (error) {
        console.error('iMIP processing failed:', error);
    }

    return result;
}

export async function messageGetFile(user: User, messageId: string) {
    const mail = await getMailClient(user);
    return await mail.messageGetFile(messageId);
}

export async function messageGet(user: User, messageId: string): Promise<Email> {
    const mail = await getMailClient(user);
    const message = await mail.messageGet(messageId);
    if (!message) {
        throw new ApiError(404, `Message '${messageId}' not found`);
    }
    return message;
}

export async function messageDelete(user: User, messageId: string) {
    const mail = await getMailClient(user);
    return await mail.messageDelete(messageId);
}

export async function messageMove(user: User, messageId: string, targetMailbox: string) {
    const mail = await getMailClient(user);
    return await mail.messageMove(messageId, targetMailbox);
}

async function messageMoveToSpecial(user: User, messageId: string, flag: string) {
    const mailboxes = await mailboxesList(user);
    const target = mailboxes.find((mailbox) => mailbox.flags.includes(flag));
    if (!target) {
        throw new ApiError(404, `Mailbox with flag '${flag}' not found`);
    }
    return await messageMove(user, messageId, target.path);
}

export async function messageMoveToInbox(user: User, messageId: string) {
    return messageMoveToSpecial(user, messageId, '\\Inbox');
}

export async function messageMoveToArchive(user: User, messageId: string) {
    return messageMoveToSpecial(user, messageId, '\\Archive');
}

export async function messageMoveToSpam(user: User, messageId: string) {
    return messageMoveToSpecial(user, messageId, '\\Junk');
}

export async function messageMoveToTrash(user: User, messageId: string) {
    return messageMoveToSpecial(user, messageId, '\\Trash');
}

export async function messageCopy(user: User, messageId: string, targetMailbox: string) {
    const mail = await getMailClient(user);
    return await mail.messageCopy(messageId, targetMailbox);
}

export type DraftUpdateOptions = {
    tempAttachmentIds?: string[];
    keepAttachmentIndexes?: number[];
    forceFullSave?: boolean;
};

export async function messageHandleDraft(user: User, mail: NewDraft | EmailDraft, options?: DraftUpdateOptions) {
    const mailClient = await getMailClient(user);
    return await mailClient.messageHandleDraft(mail, options);
}

export async function uploadDraftAttachment(user: User, request: Request) {
    const maxSize = await getMailUploadMaxSize(user.id);
    const mailClient = await getMailClient(user);
    return await mailClient.uploadDraftAttachment(request, maxSize);
}

export async function attachFromDrive(
    user: User,
    sourceOwnerId: string,
    sourceMountId: string,
    sourcePathId: string,
): Promise<DraftAttachmentUpload> {
    const maxSize = await getMailUploadMaxSize(user.id);
    const mailClient = await getMailClient(user);

    const drive = await getSharedDrive(sourceOwnerId, user);
    const sourcePath = await drive.getPath(sourceMountId, sourcePathId);
    if (!sourcePath) throw new ApiError(404, 'Source file not found');
    if (sourcePath.size > maxSize) {
        const limitMB = Math.floor(maxSize / (1024 * 1024));
        throw new ApiError(413, `Attachment exceeds ${limitMB}MB limit`);
    }

    const sourceFile = await drive.downloadFile(sourceMountId, sourcePathId);
    if (!sourceFile) throw new ApiError(404, 'Source file missing on disk');

    const filename = sourcePath.details?.originalName || sourcePath.name;
    return await mailClient.stageDriveAttachment(sourceFile, filename, sourcePath.mimeType, maxSize);
}

export async function messageSend(user: User, mail: NewDraft | EmailDraft) {
    const mailClient = await getMailClient(user);
    return await mailClient.messageSend(mail);
}

export async function messageSetRead(user: User, messageId: string, read: boolean) {
    const mail = await getMailClient(user);
    return await mail.messageSetRead(messageId, read);
}

export async function messageSetFlagged(user: User, messageId: string, flagged: boolean) {
    const mail = await getMailClient(user);
    return await mail.messageSetFlagged(messageId, flagged);
}

export async function messageGetAttachment(user: User, messageId: string, index: number) {
    const mail = await getMailClient(user);
    return await mail.messageGetAttachment(messageId, index);
}

export async function saveAttachmentsToDrive(
    user: User,
    messageId: string,
    indexes: number[],
    targetOwnerId: string,
    targetMountId: string,
    targetParentId: string,
): Promise<DrivePath[]> {
    if (indexes.length === 0) throw new ApiError(400, 'No attachments selected');
    if (new Set(indexes).size !== indexes.length) throw new ApiError(400, 'Duplicate attachment indexes');
    if (indexes.some((i) => !Number.isInteger(i) || i < 0)) throw new ApiError(400, 'Invalid attachment index');

    const mail = await getMailClient(user);
    const drive = await getSharedDrive(targetOwnerId, user);
    const maxSize = await getUploadMaxSize(targetOwnerId, user.id, targetMountId);

    // Indexes refer to positions in the raw parsed EML attachment list (including calendar parts).
    // Parse the EML once and index into the result — avoids re-parsing on every iteration.
    const attachments = await mail.messageGetAttachments(messageId);
    for (const index of indexes) {
        if (index >= attachments.length) throw new ApiError(404, `Attachment ${index} not found`);
    }

    const results: DrivePath[] = [];
    for (const index of indexes) {
        const att = attachments[index];
        const filename = att.filename || `attachment-${index}`;
        // Attachment.content is typed unknown (parser origin); narrow to Uint8Array at this boundary.
        if (!(att.content instanceof Uint8Array)) {
            throw new ApiError(400, `Attachment ${index} has no content`);
        }
        const content = Buffer.isBuffer(att.content) ? att.content : Buffer.from(att.content);
        if (content.byteLength > maxSize) {
            const limitMB = Math.floor(maxSize / (1024 * 1024));
            throw new ApiError(413, `Attachment "${filename}" exceeds ${limitMB}MB drive limit`);
        }
        const result = await drive.createFileFromData(
            targetMountId,
            targetParentId,
            filename,
            att.contentType,
            content,
        );
        results.push(result);
    }
    return results;
}
