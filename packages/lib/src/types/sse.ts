// Event type constants
export const SSEventType = {
    // Mail events
    MAIL_RECEIVED: 'mail:received',
    MAIL_DELETED: 'mail:deleted',
    MAIL_MOVED: 'mail:moved',
    MAIL_READ_CHANGED: 'mail:read-changed',
    MAIL_DRAFT_UPDATED: 'mail:draft-updated',
    MAIL_FLAGS_CHANGED: 'mail:flags-changed',
    MAIL_SENT: 'mail:sent',
    // Drive events
    DRIVE_FOLDER_CREATED: 'drive:folder-created',
    DRIVE_FOLDER_DELETED: 'drive:folder-deleted',
    DRIVE_FILE_CREATED: 'drive:file-created',
    DRIVE_FILE_UPLOADED: 'drive:file-uploaded',
    DRIVE_FILE_DELETED: 'drive:file-deleted',
    DRIVE_PATH_RENAMED: 'drive:path-renamed',
    DRIVE_PATH_MOVED: 'drive:path-moved',
    DRIVE_ACL_UPDATED: 'drive:acl-updated',
    DRIVE_ACL_SHARED: 'drive:acl-shared',
    DRIVE_ACL_UNSHARED: 'drive:acl-unshared',
    DRIVE_PATH_TRASHED: 'drive:path-trashed',
    DRIVE_PATH_RESTORED: 'drive:path-restored',
    // Fires whenever a file event is recorded — invalidates open Activity panels' history queries.
    DRIVE_FILE_HISTORY_UPDATED: 'drive:file-history-updated',
    // Chat events
    CHAT_MESSAGE_POSTED: 'chat:message-posted',
    CHAT_MESSAGE_EDITED: 'chat:message-edited',
    CHAT_MESSAGE_DELETED: 'chat:message-deleted',
    CHAT_COMMENT_INDEX_UPDATED: 'chat:comment-index-updated',
    // Calendar events
    CALENDAR_EVENT_CREATED: 'calendar:event-created',
    CALENDAR_EVENT_UPDATED: 'calendar:event-updated',
    CALENDAR_EVENT_DELETED: 'calendar:event-deleted',
    CALENDAR_CREATED: 'calendar:calendar-created',
    CALENDAR_UPDATED: 'calendar:calendar-updated',
    CALENDAR_DELETED: 'calendar:calendar-deleted',
    CALENDAR_SHARED: 'calendar:shared',
    CALENDAR_UNSHARED: 'calendar:unshared',
    CALENDAR_INVITE_RECEIVED: 'calendar:invite-received',
    CALENDAR_INVITE_UPDATED: 'calendar:invite-updated',
    CALENDAR_INVITE_CANCELLED: 'calendar:invite-cancelled',
    CALENDAR_INVITE_RSVP: 'calendar:invite-rsvp',
    // Space events
    SPACE_SETTINGS_UPDATED: 'space:settings-updated',
    // Team events
    TEAM_SETTINGS_UPDATED: 'team:settings-updated',
    // Notification events
    NOTIFICATION_CREATED: 'notification:created',
    NOTIFICATION_CHANGED: 'notification:changed',
    // Contact events
    CONTACT_CREATED: 'contacts:contact-created',
    CONTACT_UPDATED: 'contacts:contact-updated',
    CONTACT_DELETED: 'contacts:contact-deleted',
    LABEL_CREATED: 'contacts:label-created',
    LABEL_UPDATED: 'contacts:label-updated',
    LABEL_DELETED: 'contacts:label-deleted',
} as const;

// --- Event data types (minimal — only what frontend handlers need for cache invalidation) ---

type SSEventDrive = {
    type: (typeof SSEventType)[keyof typeof SSEventType] & `drive:${string}`;
    path: { ownerId: string; mountId: string; id: string; parentId: string | null; mimeType: string | null };
    oldParentId?: string;
};

type SSEventMail = {
    type: (typeof SSEventType)[keyof typeof SSEventType] & `mail:${string}`;
    mail: { messageId: string; mailbox: string; toMailbox?: string };
};

type SSEventCalendar = {
    type: (typeof SSEventType)[keyof typeof SSEventType] & `calendar:${string}`;
    ownerId: string;
};

type SSEventChat = {
    type: (typeof SSEventType)[keyof typeof SSEventType] & `chat:${string}`;
    chat: { chatId: string; ownerId: string; mountId: string };
};

type SSEventContact = {
    type: typeof SSEventType.CONTACT_CREATED | typeof SSEventType.CONTACT_UPDATED | typeof SSEventType.CONTACT_DELETED;
    contactId: string;
};

type SSEventLabel = {
    type: typeof SSEventType.LABEL_CREATED | typeof SSEventType.LABEL_UPDATED | typeof SSEventType.LABEL_DELETED;
    labelId: string;
};

type SSEventNotificationCreated = {
    type: typeof SSEventType.NOTIFICATION_CREATED;
    title: string;
    body?: string;
    notificationType?: string;
    tag?: string;
};

type SSEventNotificationChanged = {
    type: typeof SSEventType.NOTIFICATION_CHANGED;
};

type SSEventSpace = {
    type: typeof SSEventType.SPACE_SETTINGS_UPDATED;
};

type SSEventTeam = {
    type: typeof SSEventType.TEAM_SETTINGS_UPDATED;
    teamId: string;
};

// Union of all events
export type SSEvent =
    | SSEventDrive
    | SSEventMail
    | SSEventCalendar
    | SSEventChat
    | SSEventContact
    | SSEventLabel
    | SSEventNotificationCreated
    | SSEventNotificationChanged
    | SSEventSpace
    | SSEventTeam;

export type {
    SSEventCalendar,
    SSEventChat,
    SSEventContact,
    SSEventDrive,
    SSEventLabel,
    SSEventMail,
    SSEventNotificationChanged,
    SSEventNotificationCreated,
    SSEventSpace,
    SSEventTeam,
};
