// The events the server sends on a tab's event stream, shared by the API that builds them and the
// handlers in the browser that read them. An event carries the ids a handler needs to know which queries
// to refetch, and rarely data (a notification's display text, the home's data epochs). A new event type
// gets its name in SSEventType and its shape in the SSEvent union.

import type { NotificationType } from './notification';

export const SSEventType = {
    MAIL_RECEIVED: 'mail:received',
    MAIL_DELETED: 'mail:deleted',
    MAIL_MOVED: 'mail:moved',
    MAIL_READ_CHANGED: 'mail:read-changed',
    MAIL_DRAFT_UPDATED: 'mail:draft-updated',
    MAIL_FLAGS_CHANGED: 'mail:flags-changed',
    MAIL_SENT: 'mail:sent',
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
    // Sent whenever a file event is recorded, so open Activity panels refresh.
    DRIVE_FILE_HISTORY_UPDATED: 'drive:file-history-updated',
    CHAT_MESSAGE_POSTED: 'chat:message-posted',
    CHAT_MESSAGE_EDITED: 'chat:message-edited',
    CHAT_MESSAGE_DELETED: 'chat:message-deleted',
    CHAT_COMMENT_INDEX_UPDATED: 'chat:comment-index-updated',
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
    NOTIFICATION_CREATED: 'notification:created',
    NOTIFICATION_CHANGED: 'notification:changed',
    CONTACT_CREATED: 'contacts:contact-created',
    CONTACT_UPDATED: 'contacts:contact-updated',
    CONTACT_DELETED: 'contacts:contact-deleted',
    CONTACTS_CHANGED: 'contacts:changed',
    LABEL_CREATED: 'contacts:label-created',
    LABEL_UPDATED: 'contacts:label-updated',
    LABEL_DELETED: 'contacts:label-deleted',
    BACKUP_JOB_UPDATED: 'backup:job-updated',
    HOME_DATA_EPOCHS: 'home:data-epochs',
} as const;

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

// A whole-file import sends this once instead of one event per card. It carries no ids, because a card
// change refetches the owner's whole list anyway.
type SSEventContactsChanged = {
    type: typeof SSEventType.CONTACTS_CHANGED;
};

type SSEventLabel = {
    type: typeof SSEventType.LABEL_CREATED | typeof SSEventType.LABEL_UPDATED | typeof SSEventType.LABEL_DELETED;
    labelId: string;
};

// The one event that carries display text: it raises the toast, which has nothing to refetch.
type SSEventNotificationCreated = {
    type: typeof SSEventType.NOTIFICATION_CREATED;
    title: string;
    body?: string;
    notificationType: NotificationType;
    tag?: string;
};

type SSEventNotificationChanged = {
    type: typeof SSEventType.NOTIFICATION_CHANGED;
};

// Sent when a backup job starts and when it ends. The admin pane refetches the job and artifact lists,
// which the server answers from its job map.
type SSEventBackup = {
    type: typeof SSEventType.BACKUP_JOB_UPDATED;
    jobId: string;
    ownerId: string;
};

// Sent when a stream opens and with every keepalive: the data epoch of the user's own home and of each of
// their teams, keyed by owner id. Only a restore changes one, so a tab reloads when an epoch it holds changes.
type SSEventHomeDataEpochs = {
    type: typeof SSEventType.HOME_DATA_EPOCHS;
    epochs: Record<string, string>;
};

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
