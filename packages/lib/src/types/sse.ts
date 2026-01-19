import type {DrivePath} from './drive';

// Lightweight mail event data (IDs and minimal fields)
export type SSEventMailData = {
    messageId: string;
    mailbox: string;
    subject?: string;
    fromShort?: string;
    toMailbox?: string;
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
type SSEventMailData_Event = SSEventBase & {
    type: typeof SSEventType.MAIL_READ_CHANGED | typeof SSEventType.MAIL_DRAFT_UPDATED;
    mail: SSEventMailData;
};

type SSEventMail = SSEventMailNotification | SSEventMailData_Event;

// Union of all events
export type SSEvent = SSEventDrive | SSEventMail;

// Type guard to check if event is a notification (has body, should show toast)
export function isSSEventNotification(event: SSEvent): event is SSEvent & SSEventNotification {
    return 'body' in event;
}

// Export individual types for consumers
export type {SSEventBase, SSEventDrive, SSEventMail};
