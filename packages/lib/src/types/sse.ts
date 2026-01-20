import type {DrivePath} from './drive';

// Lightweight mail event data (IDs and minimal fields)
export type SSEventMailData = {
    messageId: string;
    mailbox: string;
    subject?: string;
    fromShort?: string;
    toMailbox?: string;
};

// Contact/Label event data
export type SSEventContactData = {
    contactId: string;
    name?: string;
};

export type SSEventContactLabelData = {
    labelId: string;
    name?: string;
};

// Event type constants - single source of truth
export const SSEventType = {
    // Mail events
    MAIL_RECEIVED: 'mail:received',
    MAIL_DELETED: 'mail:deleted',
    MAIL_MOVED: 'mail:moved',
    MAIL_READ_CHANGED: 'mail:read-changed',
    MAIL_DRAFT_UPDATED: 'mail:draft-updated',
    MAIL_SENT: 'mail:sent',
    // Drive events
    DRIVE_FOLDER_CREATED: 'drive:folder-created',
    DRIVE_FILE_UPLOADED: 'drive:file-uploaded',
    DRIVE_FOLDER_DELETED: 'drive:folder-deleted',
    DRIVE_FILE_DELETED: 'drive:file-deleted',
    DRIVE_PATH_RENAMED: 'drive:path-renamed',
    DRIVE_PATH_MOVED: 'drive:path-moved',
    DRIVE_ACL_UPDATED: 'drive:acl-updated',
    DRIVE_ACL_SHARED: 'drive:acl-shared',
    DRIVE_ACL_UNSHARED: 'drive:acl-unshared',
    // Contact events
    CONTACT_CREATED: 'contacts:contact-created',
    CONTACT_UPDATED: 'contacts:contact-updated',
    CONTACT_DELETED: 'contacts:contact-deleted',
    LABEL_CREATED: 'contacts:label-created',
    LABEL_UPDATED: 'contacts:label-updated',
    LABEL_DELETED: 'contacts:label-deleted',
} as const;

// Base for all events
type SSEventBase = {
    title: string;
};

// Notification mixin - events that should show toasts
export type SSEventNotification = {
    body: string;
    tag?: string;
    link?: string;
};

// All Drive events share the same structure with full path
type SSEventDrive = SSEventBase & SSEventNotification & {
    type: typeof SSEventType[keyof typeof SSEventType] & `drive:${string}`;
    path: DrivePath;
    drive?: {
        oldParentId?: string;
    };
};

// Mail notification events (with body, show toast)
type SSEventMailNotification = SSEventBase & SSEventNotification & {
    type: typeof SSEventType.MAIL_RECEIVED | typeof SSEventType.MAIL_DELETED | typeof SSEventType.MAIL_MOVED | typeof SSEventType.MAIL_SENT;
    mail: SSEventMailData;
};

// Mail data-only events (no body, no toast, just cache invalidation)
type SSEventMailDataUpdate = SSEventBase & {
    type: typeof SSEventType.MAIL_READ_CHANGED | typeof SSEventType.MAIL_DRAFT_UPDATED;
    mail: SSEventMailData;
};

type SSEventMail = SSEventMailNotification | SSEventMailDataUpdate;

// Contact notification events (with body, show toast)
type SSEventContactNotification = SSEventBase & SSEventNotification & {
    type: typeof SSEventType.CONTACT_CREATED | typeof SSEventType.CONTACT_UPDATED | typeof SSEventType.CONTACT_DELETED;
    contact: SSEventContactData;
};

// Label notification events (with body, show toast)
type SSEventContactLabelNotification = SSEventBase & SSEventNotification & {
    type: typeof SSEventType.LABEL_CREATED | typeof SSEventType.LABEL_UPDATED | typeof SSEventType.LABEL_DELETED;
    label: SSEventContactLabelData;
};

type SSEventContacts = SSEventContactNotification | SSEventContactLabelNotification;

// Union of all events
export type SSEvent = SSEventDrive | SSEventMail | SSEventContacts;

// Type guard to check if event is a notification (has body, should show toast)
export function isSSEventNotification(event: SSEvent): event is SSEvent & SSEventNotification {
    return 'body' in event;
}

// Export individual types for consumers
export type {SSEventBase, SSEventDrive, SSEventMail, SSEventContacts};
