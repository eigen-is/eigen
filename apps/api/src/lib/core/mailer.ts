import { DEFAULT_RELAY_PORT, defaultSenderAddress } from '@workspace/lib/constants/mail';
import type { ImipMethod } from '@workspace/lib/types/calendar';
import { ICS_MIME } from '@workspace/lib/types/drive';
import nodemailer from 'nodemailer';
import MailComposer from 'nodemailer/lib/mail-composer';
import type Mail from 'nodemailer/lib/mailer';
import { isDemo, isMailEnabled, isProduction } from '../config/env';
import { getMailDomain, getOrgName, isInternalAddress } from '../config/server-config';
import { getServerSettings } from '../config/server-settings';

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
    // The person the mail is from; absent, it is the system's own. The mailer decides what the headers say.
    from?: OutboundAddress;
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
    // Recipients of this copy alone; the envelope sender follows the resolved From.
    envelope?: { to: string[] };
};

function systemSender(): OutboundAddress {
    const { senderName, senderAddress } = getServerSettings().mail;
    return { name: senderName || getOrgName(), address: senderAddress || defaultSenderAddress(getMailDomain()) };
}

// Postfix sends as any address on the mail domain, a relay only when the admin says it may; everyone else goes out "via".
function sendsAsThemselves(address: string): boolean {
    return isInternalAddress(address) && (isMailEnabled() || getServerSettings().mail.relaySendsAsUsers);
}

// With hosted mail, through the bundled Postfix (SMTP_HOST), which relays; without, through SMTP_RELAY_* itself.
function smtpHost(): string | undefined {
    return (isMailEnabled() ? process.env['SMTP_HOST'] : process.env['SMTP_RELAY_HOST']) || undefined;
}

export function createTransport(): Mail {
    const host = smtpHost();
    if (!host) return nodemailer.createTransport({ sendmail: true, newline: 'unix', path: '/usr/sbin/sendmail' });
    if (isMailEnabled()) {
        // Postfix owns TLS toward the internet; its own certificate is self-signed or missing.
        return nodemailer.createTransport({
            host,
            port: Number(process.env['SMTP_PORT'] || 25),
            secure: false,
            requireTLS: false,
            tls: { rejectUnauthorized: false },
        });
    }
    const port = Number(process.env['SMTP_RELAY_PORT'] || DEFAULT_RELAY_PORT);
    const user = process.env['SMTP_RELAY_USER'];
    const pass = process.env['SMTP_RELAY_PASSWORD'];
    if (user && !pass) {
        throw new Error(
            'SMTP_RELAY_USER is set without SMTP_RELAY_PASSWORD. ' +
                'Set both to authenticate to the relay, or neither for an anonymous one.',
        );
    }
    return nodemailer.createTransport({
        host,
        port,
        // Port 465 is implicit TLS; anything else starts plain and upgrades with STARTTLS.
        secure: port === 465,
        auth: user && pass ? { user, pass } : undefined,
        // Credentials only over verified TLS: without requireTLS, a relay offering no STARTTLS gets them in the clear.
        requireTLS: Boolean(user),
        tls: { rejectUnauthorized: Boolean(user) },
    });
}

export function buildMailOptions(message: OutboundMail): Mail.Options {
    const person = message.from;
    let from = systemSender();
    if (person && sendsAsThemselves(person.address)) from = person;
    else if (person) from = { name: `${person.name || person.address} via ${getOrgName()}`, address: from.address };
    const options: Mail.Options = {
        from,
        to: message.to,
        subject: message.subject,
        text: message.text,
    };
    if (person && from !== person) options.replyTo = person;
    if (message.cc?.length) options.cc = message.cc;
    if (message.bcc?.length) options.bcc = message.bcc;
    if (message.html) options.html = message.html;
    if (message.messageId) options.messageId = message.messageId;
    if (message.inReplyTo) options.inReplyTo = message.inReplyTo;
    if (message.references) options.references = message.references;
    if (message.envelope) options.envelope = { from: from.address, to: message.envelope.to };
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
    const options = buildMailOptions(message);
    // Skip outbound delivery in dev/test unless an SMTP host is explicitly configured, and always
    // in demo mode (a demo box has no MTA — a real send would throw on every share/invite/iMIP).
    if ((!isProduction() && !smtpHost()) || isDemo()) {
        console.log('[DEV] Skipping email:', { from: options.from, to: message.to, subject: message.subject });
        return true;
    }
    try {
        await createTransport().sendMail(options);
        return true;
    } catch (error) {
        // nodemailer puts the server's own reply, like "553 5.7.1 Sender address rejected", on `response`.
        const reason = error instanceof Error && 'response' in error ? error.response : error;
        console.error(`[mailer] Sending "${message.subject}" failed:`, reason);
        return false;
    }
}

// Builds the RFC822 bytes for `message` without sending. Used for local maildir delivery
// (welcome mail) where we want nodemailer's header encoding (RFC 2047), correct multipart
// boundaries, and per-part Content-Transfer-Encoding but don't need to go over SMTP.
export async function composeRfc822(message: OutboundMail): Promise<Buffer> {
    return new MailComposer(buildMailOptions(message)).compile().build();
}
