import type { ImipMethod } from '@workspace/lib/types/calendar';
import nodemailer from 'nodemailer';
import MailComposer from 'nodemailer/lib/mail-composer';
import type Mail from 'nodemailer/lib/mailer';
import { isDemo, isProduction } from '../config/env';
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
    messageId?: string;
    inReplyTo?: string;
    references?: string | string[];
    envelope?: { from: string; to: string[] };
};

export function createTransport(): Mail {
    if (process.env['SMTP_HOST']) {
        // This hop stays inside the docker network (SMTP_HOST defaults to the bundled postfix)
        // or reaches a host-local relay — self-signed/no cert, so verification is off by design.
        // Postfix owns TLS toward the internet.
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

export function buildMailOptions(message: OutboundMail): Mail.Options {
    const options: Mail.Options = {
        from: message.from ?? { name: '', address: `noreply@${getMailDomain()}` },
        to: message.to,
        subject: message.subject,
        text: message.text,
    };
    if (message.replyTo) options.replyTo = message.replyTo;
    if (message.cc?.length) options.cc = message.cc;
    if (message.bcc?.length) options.bcc = message.bcc;
    if (message.html) options.html = message.html;
    if (message.messageId) options.messageId = message.messageId;
    if (message.inReplyTo) options.inReplyTo = message.inReplyTo;
    if (message.references) options.references = message.references;
    if (message.envelope) options.envelope = message.envelope;
    if (message.attachments?.length) {
        options.attachments = message.attachments.map((a) => ({
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
        options.alternatives = [
            {
                raw: `Content-Type: text/calendar; charset=utf-8; method=${message.icalEvent.method}\r\nContent-Transfer-Encoding: base64\r\n\r\n${icsBase64}`,
            },
        ];
        options.attachments = [
            ...(options.attachments ?? []),
            { filename: 'invite.ics', content: icsBuffer, contentType: 'application/ics' },
        ];
    }
    return options;
}

export async function sendMail(message: OutboundMail): Promise<boolean> {
    // Skip outbound delivery in dev/test unless an SMTP host is explicitly configured, and always
    // in demo mode (a demo box has no MTA — a real send would throw on every share/invite/iMIP).
    if ((!isProduction() && !process.env['SMTP_HOST']) || isDemo()) {
        console.log('[DEV] Skipping email:', {
            from: message.from ?? { name: '', address: `noreply@${getMailDomain()}` },
            to: message.to,
            subject: message.subject,
        });
        return true;
    }
    try {
        await createTransport().sendMail(buildMailOptions(message));
        return true;
    } catch (error) {
        console.error('Failed to send email:', error);
        return false;
    }
}

// Builds the RFC822 bytes for `message` without sending. Used for local maildir delivery
// (welcome mail) where we want nodemailer's header encoding (RFC 2047), correct multipart
// boundaries, and per-part Content-Transfer-Encoding but don't need to go over SMTP.
export async function composeRfc822(message: OutboundMail): Promise<Buffer> {
    return new MailComposer(buildMailOptions(message)).compile().build();
}
