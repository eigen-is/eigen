// Event type constants - single source of truth
export const SSEventType = {
    // Mail events
    MAIL_RECEIVED: 'mail:received',
    // Drive data events (no toast)
    DRIVE_FOLDER_CREATED: 'drive:folder-created',
    DRIVE_FILE_UPLOADED: 'drive:file-uploaded',
    DRIVE_FOLDER_DELETED: 'drive:folder-deleted',
    DRIVE_FILE_DELETED: 'drive:file-deleted',
    DRIVE_PATH_RENAMED: 'drive:path-renamed',
    DRIVE_PATH_MOVED: 'drive:path-moved',
    DRIVE_ACL_UPDATED: 'drive:acl-updated',
    // Drive notification events (show toast)
    DRIVE_ACL_SHARED: 'drive:acl-shared',
    DRIVE_ACL_UNSHARED: 'drive:acl-unshared',
} as const;

// Base for all events
type SSEventBase = {
    title: string;
};

// Notification mixin - events that should show toasts
type SSEventNotification = {
    body: string;
    tag?: string;
    link?: string;
};

// Drive data events (no toast, just sync)
type SSEventDrivePathChange = SSEventBase & {
    type: typeof SSEventType.DRIVE_FOLDER_CREATED | typeof SSEventType.DRIVE_FILE_UPLOADED 
        | typeof SSEventType.DRIVE_FOLDER_DELETED | typeof SSEventType.DRIVE_FILE_DELETED 
        | typeof SSEventType.DRIVE_PATH_RENAMED | typeof SSEventType.DRIVE_ACL_UPDATED;
    data: { pathId: string; parentId: string | null };
};

type SSEventDrivePathMoved = SSEventBase & {
    type: typeof SSEventType.DRIVE_PATH_MOVED;
    data: { pathId: string; parentId: string | null; oldParentId: string | null };
};

// Drive notification events (show toast)
type SSEventDriveShared = SSEventBase & SSEventNotification & {
    type: typeof SSEventType.DRIVE_ACL_SHARED;
    data: { pathId: string };
};

type SSEventDriveUnshared = SSEventBase & SSEventNotification & {
    type: typeof SSEventType.DRIVE_ACL_UNSHARED;
    data: { pathId: string };
};

type SSEventDrive = SSEventDrivePathChange | SSEventDrivePathMoved | SSEventDriveShared | SSEventDriveUnshared;

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
export type { SSEventBase, SSEventNotification, SSEventDrive, SSEventMail };
