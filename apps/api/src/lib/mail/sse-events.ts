import type {SSEvent, SSEventMailData} from '@workspace/lib/types/sse';
import {SSEventType} from '@workspace/lib/types/sse';

type MailEventType = typeof SSEventType[keyof typeof SSEventType] & `mail:${string}`;

type NotificationTemplate = {
    title: string;
    body: (mail: SSEventMailData) => string;
};

const notificationTemplates: Partial<Record<MailEventType, NotificationTemplate>> = {
    [SSEventType.MAIL_RECEIVED]: {
        title: 'New email',
        body: (m) => m.subject ? `${m.fromShort}: ${m.subject}` : `New email from ${m.fromShort}`
    },
    [SSEventType.MAIL_DELETED]: {
        title: 'Email deleted',
        body: (m) => m.subject ? `"${m.subject}" deleted` : 'Email deleted'
    },
    [SSEventType.MAIL_MOVED]: {
        title: 'Email moved',
        body: (m) => m.toMailbox ? `Moved to ${m.toMailbox}` : 'Email moved'
    },
    [SSEventType.MAIL_SENT]: {
        title: 'Email sent',
        body: (m) => m.subject ? `"${m.subject}" sent` : 'Email sent'
    },
};

const dataOnlyTitles: Partial<Record<MailEventType, string>> = {
    [SSEventType.MAIL_READ_CHANGED]: 'Read status changed',
    [SSEventType.MAIL_DRAFT_UPDATED]: 'Draft updated',
    [SSEventType.MAIL_FLAGS_CHANGED]: 'Flags changed',
};

type MailEventOptions = {
    tag?: string;
    link?: string;
};

export function buildMailEvent(type: MailEventType, mail: SSEventMailData, options?: MailEventOptions): SSEvent {
    const notificationTemplate = notificationTemplates[type];

    if (notificationTemplate) {
        return {
            type,
            title: notificationTemplate.title,
            body: notificationTemplate.body(mail),
            mail,
            ...(options?.tag && {tag: options.tag}),
            ...(options?.link && {link: options.link}),
        } as SSEvent;
    }

    return {
        type,
        title: dataOnlyTitles[type] || type,
        mail,
    } as SSEvent;
}
