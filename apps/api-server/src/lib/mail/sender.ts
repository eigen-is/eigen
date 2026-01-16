import nodemailer from 'nodemailer';
import type Mail from 'nodemailer/lib/mailer';
import type {EmailDraft} from "../../types/mail";

interface Address {
    name: string;
    address: string;
}

export interface SendMailOptions {
    from: Address;
    to: Address[];
    cc?: Address[];
    bcc?: Address[];
    subject: string;
    text: string;
    html?: string;
}

function createTransport(): Mail {
    return nodemailer.createTransport({
        sendmail: true,
        newline: 'unix',
        path: '/usr/sbin/sendmail'
    });
}

function convertAddressValue(value: {name?: string; address?: string}[] | undefined): Address[] {
    if (!value) return [];
    return value
        .filter(v => v.address)
        .map(v => ({name: v.name || '', address: v.address!}));
}

export function draftToMailOptions(draft: EmailDraft, fallbackEmail: string): SendMailOptions {
    const fromValue = draft.from?.value?.[0];
    
    return {
        from: fromValue?.address 
            ? {name: fromValue.name || '', address: fromValue.address}
            : {name: '', address: fallbackEmail},
        to: convertAddressValue(draft.to?.value),
        cc: convertAddressValue(draft.cc?.value),
        bcc: convertAddressValue(draft.bcc?.value),
        subject: draft.subject || '(No subject)',
        text: draft.text || '',
        html: draft.html || undefined
    };
}

export async function sendMail(options: SendMailOptions): Promise<boolean> {
    const transporter = createTransport();
    
    const mailOptions: Mail.Options = {
        from: options.from as Mail.Address,
        to: options.to as Mail.Address[],
        subject: options.subject,
        text: options.text
    };

    if (options.cc?.length) {
        mailOptions.cc = options.cc as Mail.Address[];
    }
    if (options.bcc?.length) {
        mailOptions.bcc = options.bcc as Mail.Address[];
    }
    if (options.html) {
        mailOptions.html = options.html;
    }

    try {
        await transporter.sendMail(mailOptions);
        return true;
    } catch (error) {
        console.error('Error sending email:', error);
        return false;
    }
}
