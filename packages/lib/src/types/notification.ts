export const NotificationTypes = {
    MAIL_RECEIVED: 'mail:received',
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

export type NotificationType = typeof NotificationTypes[keyof typeof NotificationTypes];

export interface EigenNotification {
    type: NotificationType;
    title: string;
    body: string;
    tag?: string;
    link?: string;
    showToast?: boolean;
    data?: {
        pathId?: string;
        parentId?: string | null;
        oldParentId?: string | null;
        folderId?: string;
        mimeType?: string;
    };
}
