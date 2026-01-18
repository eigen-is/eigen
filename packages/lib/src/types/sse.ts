import type {DrivePath} from './drive';

// Event type constants - single source of truth
export const SSEventType = {
    // Mail events
    MAIL_RECEIVED: 'mail:received',
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
};

// Mail notification events (show toast)
type SSEventMail = SSEventBase & SSEventNotification & {
    type: typeof SSEventType.MAIL_RECEIVED;
};

// Union of all events
export type SSEvent = SSEventDrive | SSEventMail;

// Type guard to check if event is a notification (has body, should show toast)
export function isSSEventNotification(event: SSEvent): event is SSEvent & SSEventNotification {
    return 'body' in event;
}

// Export individual types for consumers
export type { SSEventBase, SSEventDrive, SSEventMail };
