import type { Email } from '@workspace/lib/types/mail';
import type { BunFile } from 'bun';
import DOMPurify from 'isomorphic-dompurify';
import { simpleParser } from './mail-parser';

export async function parseEml(messageId: string, mailbox: string, file: BunFile): Promise<Email | null> {
    try {
        const parsedMail = await simpleParser(Buffer.from(await file.arrayBuffer()), {});

        if (parsedMail.html) {
            parsedMail.html = DOMPurify.sanitize(parsedMail.html, { FORCE_BODY: true });
            parsedMail.html = parsedMail.html.replace(/\s+/g, ' ').trim();
        }

        return {
            ...parsedMail,
            id: messageId,
            filename: '',
            mailbox,
            size: file.size,
            isRead: false,
            isFlagged: false,
            isDraft: false,
            isReplied: false,
            hasAttachments: parsedMail.attachments?.length > 0,
            fromShort: parsedMail.from?.value[0]?.name || parsedMail.from?.value[0]?.address || 'Unknown',
            textShort: parsedMail.text || '',
        } as Email;
    } catch (error) {
        console.error(`Error parsing message ${messageId}:`, error);
        return null;
    }
}
