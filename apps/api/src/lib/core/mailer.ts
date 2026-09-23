import type { ImipMethod } from '@workspace/lib/types/calendar';
import { ICS_MIME } from '@workspace/lib/types/drive';
import nodemailer from 'nodemailer';
import addressparser from 'nodemailer/lib/addressparser';
import MailComposer from 'nodemailer/lib/mail-composer';
import type Mail from 'nodemailer/lib/mailer';
import { isDemo, isMailEnabled, isProduction } from '../config/env';
import { getMailDomain, getOrgName, isInternalAddress } from '../config/server-config';

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

// SMTP_FROM is `Name <address>` or a bare address; a bare one keeps the org name.
export function defaultFrom(): OutboundAddress {
    const [configured] = addressparser(process.env['SMTP_FROM'] ?? '', { flatten: true });
    if (!configured?.address) return { name: getOrgName(), address: `noreply@${getMailDomain()}` };
    return { name: configured.name || getOrgName(), address: configured.address };
}

// A relay only accepts senders it has verified and receivers enforce DMARC, so a user's address sends
// itself only when this server hosts it; otherwise the system sender carries it and replies reach the user.
export function onBehalfOf(user: OutboundAddress): Pick<OutboundMail, 'from' | 'replyTo'> {
    if (isMailEnabled() && isInternalAddress(user.address)) return { from: user };
    const system = defaultFrom();
    return {
        from: { name: `${user.name || user.address} via ${system.name}`, address: system.address },
        replyTo: user,
    };
}

export function createTransport(): Mail {
    const host = process.env['SMTP_HOST'];
    if (host) {
        const port = Number(process.env['SMTP_PORT'] || 25);
        const user = process.env['SMTP_USER'];
        const pass = process.env['SMTP_PASSWORD'];
        if (user && !pass) {
            throw new Error(
                'SMTP_USER is set without SMTP_PASSWORD. ' +
                    'Set both to authenticate to the relay, or neither for an anonymous hop.',
            );
        }
        // Port 465 is implicit TLS; anything else starts plain and upgrades with STARTTLS.
        const secureEnv = process.env['SMTP_SECURE'];
        const secure = secureEnv ? secureEnv === '1' : port === 465;
        return nodemailer.createTransport({
            host,
            port,
            secure,
            auth: user && pass ? { user, pass } : undefined,
            // An unauthenticated hop is the bundled postfix or a host-local relay (self-signed/no
            // cert) and postfix owns TLS toward the internet, but credentials only go over a
            // connection that is encrypted and whose certificate checks out — without
            // requireTLS nodemailer skips STARTTLS when the server doesn't advertise it.
            requireTLS: Boolean(user),
            tls: { rejectUnauthorized: Boolean(user) },
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
        from: message.from ?? defaultFrom(),
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
    if (message.attachments?.length) options.attachments = message.attachments;
    if (message.icalEvent) {
        // Build iMIP MIME: text/calendar in multipart/alternative + application/ics attachment.
        // Use raw alternative with base64 to avoid quoted-printable mangling iCal = signs.
        const icsBuffer = Buffer.from(message.icalEvent.content, 'utf-8');
        const icsBase64 = icsBuffer.toString('base64');
        options.alternatives = [
            {
                raw: `Content-Type: ${ICS_MIME}; charset=utf-8; method=${message.icalEvent.method}\r\nContent-Transfer-Encoding: base64\r\n\r\n${icsBase64}`,
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
            from: message.from ?? defaultFrom(),
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
