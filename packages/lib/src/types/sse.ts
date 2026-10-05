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
    CALENDAR_EVENTS_CHANGED: 'calendar:events-changed',
    // Notification events
    NOTIFICATION_CREATED: 'notification:created',
    NOTIFICATION_CHANGED: 'notification:changed',
    // Contact events
    CONTACT_CREATED: 'contacts:contact-created',
    CONTACT_UPDATED: 'contacts:contact-updated',
    CONTACT_DELETED: 'contacts:contact-deleted',
    CONTACTS_CHANGED: 'contacts:changed',
    LABEL_CREATED: 'contacts:label-created',
    LABEL_UPDATED: 'contacts:label-updated',
    LABEL_DELETED: 'contacts:label-deleted',
    // Backup events (admin only)
    BACKUP_JOB_UPDATED: 'backup:job-updated',
    // Home events
    HOME_DATA_EPOCHS: 'home:data-epochs',
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

// The list-level counterpart to the three per-card events, emitted once by a whole-file import instead of one
// event per card. It carries no ids because the per-card handler ignores them too: a card change invalidates
// the owner's whole list, so a thousand ids would be payload no handler reads.
type SSEventContactsChanged = {
    type: typeof SSEventType.CONTACTS_CHANGED;
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

// Sent on every state or progress change: a home job's to every admin, since any of them can have the pane open,
// and a server job's to the owner alone.
// The payload is a poke: the pane refetches the job and artifact lists, which the server answers from
// the job map.
type SSEventBackup = {
    type: typeof SSEventType.BACKUP_JOB_UPDATED;
    jobId: string;
    ownerId: string;
};

// Sent when a stream opens and with every keepalive: the data epoch of the user's own home and of each of their
// teams, keyed by owner id. Only a restore changes one, so a tab reloads when an epoch it already holds changes.
type SSEventHomeDataEpochs = {
    type: typeof SSEventType.HOME_DATA_EPOCHS;
    epochs: Record<string, string>;
};

// Union of all events
export type SSEvent =
    | SSEventBackup
    | SSEventDrive
    | SSEventMail
    | SSEventCalendar
    | SSEventChat
    | SSEventContact
    | SSEventContactsChanged
    | SSEventHomeDataEpochs
    | SSEventLabel
    | SSEventNotificationCreated
    | SSEventNotificationChanged;

export type {
    SSEventBackup,
    SSEventCalendar,
    SSEventChat,
    SSEventContact,
    SSEventContactsChanged,
    SSEventDrive,
    SSEventHomeDataEpochs,
    SSEventLabel,
    SSEventMail,
    SSEventNotificationChanged,
    SSEventNotificationCreated,
};
