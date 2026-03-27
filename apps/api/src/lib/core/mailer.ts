import nodemailer from 'nodemailer';
import type Mail from 'nodemailer/lib/mailer';
import {getDomain} from '../config/server-config';
import {isProduction} from '../config/paths';

// Outbound email types — the inbound parsing types live in packages/lib/types/mail.ts
type OutboundAddress = {
    name: string;
    address: string;
};

export type OutboundAttachment = {
    filename: string;
    content: Buffer | string;
    contentType?: string;
};

export type OutboundMail = {
    from?: OutboundAddress;
    to: OutboundAddress[];
    cc?: OutboundAddress[];
    bcc?: OutboundAddress[];
    subject: string;
    text: string;
    html?: string;
    attachments?: OutboundAttachment[];
};

function createTransport(): Mail {
    return nodemailer.createTransport({
        sendmail: true,
        newline: 'unix',
        path: '/usr/sbin/sendmail',
    });
}

export async function sendMail(message: OutboundMail): Promise<boolean> {
    const from = message.from ?? {name: '', address: `noreply@${getDomain()}`};

    if (!isProduction()) {
        console.log('[DEV] Skipping email:', {from, to: message.to, subject: message.subject});
        return true;
    }

    const mailOptions: Mail.Options = {
        from,
        to: message.to,
        subject: message.subject,
        text: message.text,
    };

    if (message.cc?.length) mailOptions.cc = message.cc;
    if (message.bcc?.length) mailOptions.bcc = message.bcc;
    if (message.html) mailOptions.html = message.html;
    if (message.attachments?.length) {
        mailOptions.attachments = message.attachments.map(a => ({
            filename: a.filename,
            content: a.content,
            contentType: a.contentType,
        }));
    }

    try {
        await createTransport().sendMail(mailOptions);
        return true;
    } catch (error) {
        console.error('Failed to send email:', error);
        return false;
    }
}
