import nodemailer from 'nodemailer';
import type Mail from 'nodemailer/lib/mailer';
import { isProduction } from '../config/env';
import { getDomain } from '../config/server-config';

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
    replyTo?: OutboundAddress;
    to: OutboundAddress[];
    cc?: OutboundAddress[];
    bcc?: OutboundAddress[];
    subject: string;
    text: string;
    html?: string;
    attachments?: OutboundAttachment[];
};

export function createTransport(): Mail {
    if (process.env['SMTP_HOST']) {
        return nodemailer.createTransport({
            host: process.env['SMTP_HOST'],
            port: Number(process.env['SMTP_PORT'] || 25),
            secure: false,
        });
    }
    return nodemailer.createTransport({
        sendmail: true,
        newline: 'unix',
        path: '/usr/sbin/sendmail',
    });
}

export async function sendMail(message: OutboundMail): Promise<boolean> {
    const from = message.from ?? { name: '', address: `noreply@${getDomain()}` };

    if (!isProduction() && getDomain() === 'localhost') {
        console.log('[DEV] Skipping email:', { from, to: message.to, subject: message.subject });
        return true;
    }

    const mailOptions: Mail.Options = {
        from,
        to: message.to,
        subject: message.subject,
        text: message.text,
    };

    if (message.replyTo) mailOptions.replyTo = message.replyTo;
    if (message.cc?.length) mailOptions.cc = message.cc;
    if (message.bcc?.length) mailOptions.bcc = message.bcc;
    if (message.html) mailOptions.html = message.html;
    if (message.attachments?.length) {
        mailOptions.attachments = message.attachments.map((a) => ({
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
