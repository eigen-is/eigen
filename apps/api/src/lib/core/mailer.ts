import type { ImipMethod } from '@workspace/lib/types/calendar';
import nodemailer from 'nodemailer';
import type Mail from 'nodemailer/lib/mailer';
import { isProduction } from '../config/env';
import { getMailDomain } from '../config/server-config';

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

export type OutboundICalEvent = {
    method: ImipMethod;
    content: string;
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
    icalEvent?: OutboundICalEvent;
};

export function createTransport(): Mail {
    if (process.env['SMTP_HOST']) {
        return nodemailer.createTransport({
            host: process.env['SMTP_HOST'],
            port: Number(process.env['SMTP_PORT'] || 25),
            secure: false,
            tls: { rejectUnauthorized: false },
        });
    }
    return nodemailer.createTransport({
        sendmail: true,
        newline: 'unix',
        path: '/usr/sbin/sendmail',
    });
}

export async function sendMail(message: OutboundMail): Promise<boolean> {
    const from = message.from ?? { name: '', address: `noreply@${getMailDomain()}` };

    // Skip outbound delivery in dev/test unless an SMTP host is explicitly configured.
    if (!isProduction() && !process.env['SMTP_HOST']) {
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
    if (message.icalEvent) {
        // Build iMIP MIME: text/calendar in multipart/alternative + application/ics attachment.
        // Use raw alternative with base64 to avoid quoted-printable mangling iCal = signs.
        const icsBuffer = Buffer.from(message.icalEvent.content, 'utf-8');
        const icsBase64 = icsBuffer.toString('base64');
        mailOptions.alternatives = [
            {
                raw: `Content-Type: text/calendar; charset=utf-8; method=${message.icalEvent.method}\r\nContent-Transfer-Encoding: base64\r\n\r\n${icsBase64}`,
            },
        ];
        mailOptions.attachments = [
            ...(mailOptions.attachments ?? []),
            { filename: 'invite.ics', content: icsBuffer, contentType: 'application/ics' },
        ];
    }

    try {
        await createTransport().sendMail(mailOptions);
        return true;
    } catch (error) {
        console.error('Failed to send email:', error);
        return false;
    }
}
