import type {SSEvent, SSEventContactData, SSEventContactLabelData} from '@workspace/lib/types/sse';
import {SSEventType} from '@workspace/lib/types/sse';

type ContactEventType = typeof SSEventType.CONTACT_CREATED | typeof SSEventType.CONTACT_UPDATED | typeof SSEventType.CONTACT_DELETED;
type LabelEventType = typeof SSEventType.LABEL_CREATED | typeof SSEventType.LABEL_UPDATED | typeof SSEventType.LABEL_DELETED;

type ContactNotificationTemplate = {
    title: string;
    body: (contact: SSEventContactData) => string;
};

type LabelNotificationTemplate = {
    title: string;
    body: (label: SSEventContactLabelData) => string;
};

const contactTemplates: Record<ContactEventType, ContactNotificationTemplate> = {
    [SSEventType.CONTACT_CREATED]: {
        title: 'Contact created',
        body: (c) => c.name ? `"${c.name}" added` : 'New contact added'
    },
    [SSEventType.CONTACT_UPDATED]: {
        title: 'Contact updated',
        body: (c) => c.name ? `"${c.name}" updated` : 'Contact updated'
    },
    [SSEventType.CONTACT_DELETED]: {
        title: 'Contact deleted',
        body: (c) => c.name ? `"${c.name}" deleted` : 'Contact deleted'
    },
};

const labelTemplates: Record<LabelEventType, LabelNotificationTemplate> = {
    [SSEventType.LABEL_CREATED]: {
        title: 'Label created',
        body: (l) => l.name ? `"${l.name}" added` : 'New label added'
    },
    [SSEventType.LABEL_UPDATED]: {
        title: 'Label updated',
        body: (l) => l.name ? `"${l.name}" updated` : 'Label updated'
    },
    [SSEventType.LABEL_DELETED]: {
        title: 'Label deleted',
        body: (l) => l.name ? `"${l.name}" deleted` : 'Label deleted'
    },
};

type ContactEventOptions = {
    tag?: string;
    link?: string;
};

export function buildContactEvent(type: ContactEventType, contact: SSEventContactData, options?: ContactEventOptions): SSEvent {
    const template = contactTemplates[type];
    return {
        type,
        title: template.title,
        body: template.body(contact),
        contact,
        ...(options?.tag && {tag: options.tag}),
        ...(options?.link && {link: options.link}),
    } as SSEvent;
}

export function buildLabelEvent(type: LabelEventType, label: SSEventContactLabelData, options?: ContactEventOptions): SSEvent {
    const template = labelTemplates[type];
    return {
        type,
        title: template.title,
        body: template.body(label),
        label,
        ...(options?.tag && {tag: options.tag}),
        ...(options?.link && {link: options.link}),
    } as SSEvent;
}
