import type { DrivePath } from '@workspace/lib/types/drive';
import type { DraftAttachmentUpload, Email } from '@workspace/lib/types/mail';
import { getMailUploadMaxSize, getUploadMaxSize } from '../config/enforcement';
import { ApiError } from '../core/errors';
import { getSharedDrive } from '../drive';
import { getHome } from '../home';
import type { User } from '../user';
import { getUserByEmail } from '../user/';

export async function getMailClient(user: User) {
    const home = await getHome(user.id);
    return home.mail;
}

export async function mailboxDeliver(to: string, file: ArrayBuffer) {
    const user = await getUserByEmail(to);
    if (!user) {
        throw new ApiError(404, `Recipient '${to}' not found`);
    }
    const home = await getHome(user.id);
    // Write raw bytes verbatim — decoding to a string mangles non-UTF-8 mail (Latin-1/Shift-JIS/binary).
    return home.mail.mailboxDeliver(Buffer.from(file));
}

export async function messageGet(user: User, messageId: string): Promise<Email> {
    const mail = await getMailClient(user);
    const message = await mail.messageGet(messageId);
    if (!message) {
        throw new ApiError(404, `Message '${messageId}' not found`);
    }
    return message;
}

export async function messageMoveToTrash(user: User, messageId: string) {
    const mail = await getMailClient(user);
    const mailboxes = await mail.mailboxesList();
    const target = mailboxes.find((mailbox) => mailbox.flags.includes('\\Trash'));
    if (!target) {
        throw new ApiError(404, "Mailbox with flag '\\Trash' not found");
    }
    return await mail.messageMove(messageId, target.path);
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

    // Validate + materialize every selected attachment BEFORE the first write, so a late invalid or
    // oversized attachment can't leave earlier files persisted (a retry would then duplicate them).
    const prepared = indexes.map((index) => {
        const att = attachments[index];
        const filename = att.filename || `attachment-${index}`;
        const content = Buffer.from(att.content);
        if (content.byteLength > maxSize) {
            const limitMB = Math.floor(maxSize / (1024 * 1024));
            throw new ApiError(413, `Attachment "${filename}" exceeds ${limitMB}MB drive limit`);
        }
        return { filename, contentType: att.contentType, content };
    });

    const results: DrivePath[] = [];
    for (const { filename, contentType, content } of prepared) {
        results.push(
            await drive.createFileFromData(targetMountId, targetParentId, filename, contentType, content, user),
        );
    }
    return results;
}
