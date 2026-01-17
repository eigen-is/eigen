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
    type: 'drive:folder-created' | 'drive:file-uploaded' | 'drive:folder-deleted'
        | 'drive:file-deleted' | 'drive:path-renamed' | 'drive:acl-updated';
    data: { pathId: string; parentId: string | null };
};

type SSEventDrivePathMoved = SSEventBase & {
    type: 'drive:path-moved';
    data: { pathId: string; parentId: string | null; oldParentId: string | null };
};

// Drive notification events (show toast)
type SSEventDriveShared = SSEventBase & SSEventNotification & {
    type: 'drive:acl-shared';
    data: { pathId: string };
};

type SSEventDriveUnshared = SSEventBase & SSEventNotification & {
    type: 'drive:acl-unshared';
    data: { pathId: string };
};

type SSEventDrive = SSEventDrivePathChange | SSEventDrivePathMoved | SSEventDriveShared | SSEventDriveUnshared;

// Mail notification events (show toast)
type SSEventMail = SSEventBase & SSEventNotification & {
    type: 'mail:received';
};

// Union of all events
export type SSEvent = SSEventDrive | SSEventMail;

// Type guard to check if event is a notification (has body, should show toast)
export function isSSEventNotification(event: SSEvent): event is SSEvent & SSEventNotification {
    return 'body' in event;
}

// Export individual types for consumers
export type { SSEventBase, SSEventNotification, SSEventDrive, SSEventMail };
