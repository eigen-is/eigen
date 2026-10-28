import { expect, test } from 'bun:test';
import type {
    SSEvent,
    SSEventCalendar,
    SSEventChat,
    SSEventContact,
    SSEventDrive,
    SSEventLabel,
    SSEventMail,
    SSEventTypeName,
} from '@workspace/lib/types/sse';
import { SSEventType } from '@workspace/lib/types/sse';
import { handleSSEvent } from '../../../core/sse/sse-handlers';
import { installHappyDom } from '../../happy-dom';
import { invalidatedBy } from '../../invalidation';

// The epochs handler keeps what it heard in sessionStorage, which only a window has.
const window = installHappyDom();

const OWNER = 'owner-1';

const drive = <T extends SSEventDrive['type']>(type: T) => ({
    type,
    path: { ownerId: OWNER, mountId: 'mount-1', id: 'path-1', parentId: 'parent-1', mimeType: 'text/plain' },
});
const mail = <T extends SSEventMail['type']>(type: T) => ({ type, mail: { messageId: 'msg-1', mailbox: 'INBOX' } });
const chat = <T extends SSEventChat['type']>(type: T) => ({
    type,
    chat: { chatId: 'chat-1', ownerId: OWNER, mountId: 'mount-1' },
});
const calendar = <T extends SSEventCalendar['type']>(type: T) => ({ type, ownerId: OWNER });
const contact = <T extends SSEventContact['type']>(type: T) => ({ type, contactId: 'contact-1' });
const label = <T extends SSEventLabel['type']>(type: T) => ({ type, labelId: 'label-1' });

const SAMPLES: { [T in SSEventTypeName]: SSEvent & { type: T } } = {
    [SSEventType.MAIL_RECEIVED]: mail(SSEventType.MAIL_RECEIVED),
    [SSEventType.MAIL_DELETED]: mail(SSEventType.MAIL_DELETED),
    [SSEventType.MAIL_MOVED]: mail(SSEventType.MAIL_MOVED),
    [SSEventType.MAIL_READ_CHANGED]: mail(SSEventType.MAIL_READ_CHANGED),
    [SSEventType.MAIL_DRAFT_UPDATED]: mail(SSEventType.MAIL_DRAFT_UPDATED),
    [SSEventType.MAIL_FLAGS_CHANGED]: mail(SSEventType.MAIL_FLAGS_CHANGED),
    [SSEventType.MAIL_SENT]: mail(SSEventType.MAIL_SENT),
    [SSEventType.DRIVE_FOLDER_CREATED]: drive(SSEventType.DRIVE_FOLDER_CREATED),
    [SSEventType.DRIVE_FOLDER_DELETED]: drive(SSEventType.DRIVE_FOLDER_DELETED),
    [SSEventType.DRIVE_FILE_CREATED]: drive(SSEventType.DRIVE_FILE_CREATED),
    [SSEventType.DRIVE_FILE_UPLOADED]: drive(SSEventType.DRIVE_FILE_UPLOADED),
    [SSEventType.DRIVE_FILE_DELETED]: drive(SSEventType.DRIVE_FILE_DELETED),
    [SSEventType.DRIVE_PATH_RENAMED]: drive(SSEventType.DRIVE_PATH_RENAMED),
    [SSEventType.DRIVE_PATH_MOVED]: drive(SSEventType.DRIVE_PATH_MOVED),
    [SSEventType.DRIVE_ACL_UPDATED]: drive(SSEventType.DRIVE_ACL_UPDATED),
    [SSEventType.DRIVE_ACL_SHARED]: drive(SSEventType.DRIVE_ACL_SHARED),
    [SSEventType.DRIVE_ACL_UNSHARED]: drive(SSEventType.DRIVE_ACL_UNSHARED),
    [SSEventType.DRIVE_PATH_TRASHED]: drive(SSEventType.DRIVE_PATH_TRASHED),
    [SSEventType.DRIVE_PATH_RESTORED]: drive(SSEventType.DRIVE_PATH_RESTORED),
    [SSEventType.DRIVE_FILE_HISTORY_UPDATED]: drive(SSEventType.DRIVE_FILE_HISTORY_UPDATED),
    [SSEventType.CHAT_MESSAGE_POSTED]: chat(SSEventType.CHAT_MESSAGE_POSTED),
    [SSEventType.CHAT_MESSAGE_EDITED]: chat(SSEventType.CHAT_MESSAGE_EDITED),
    [SSEventType.CHAT_MESSAGE_DELETED]: chat(SSEventType.CHAT_MESSAGE_DELETED),
    [SSEventType.CHAT_COMMENT_INDEX_UPDATED]: chat(SSEventType.CHAT_COMMENT_INDEX_UPDATED),
    [SSEventType.CALENDAR_EVENT_CREATED]: calendar(SSEventType.CALENDAR_EVENT_CREATED),
    [SSEventType.CALENDAR_EVENT_UPDATED]: calendar(SSEventType.CALENDAR_EVENT_UPDATED),
    [SSEventType.CALENDAR_EVENT_DELETED]: calendar(SSEventType.CALENDAR_EVENT_DELETED),
    [SSEventType.CALENDAR_CREATED]: calendar(SSEventType.CALENDAR_CREATED),
    [SSEventType.CALENDAR_UPDATED]: calendar(SSEventType.CALENDAR_UPDATED),
    [SSEventType.CALENDAR_DELETED]: calendar(SSEventType.CALENDAR_DELETED),
    [SSEventType.CALENDAR_SHARED]: calendar(SSEventType.CALENDAR_SHARED),
    [SSEventType.CALENDAR_UNSHARED]: calendar(SSEventType.CALENDAR_UNSHARED),
    [SSEventType.CALENDAR_INVITE_RECEIVED]: calendar(SSEventType.CALENDAR_INVITE_RECEIVED),
    [SSEventType.CALENDAR_INVITE_UPDATED]: calendar(SSEventType.CALENDAR_INVITE_UPDATED),
    [SSEventType.CALENDAR_INVITE_CANCELLED]: calendar(SSEventType.CALENDAR_INVITE_CANCELLED),
    [SSEventType.CALENDAR_INVITE_RSVP]: calendar(SSEventType.CALENDAR_INVITE_RSVP),
    [SSEventType.CALENDAR_EVENTS_CHANGED]: calendar(SSEventType.CALENDAR_EVENTS_CHANGED),
    [SSEventType.NOTIFICATION_CREATED]: {
        type: SSEventType.NOTIFICATION_CREATED,
        title: 'Shared with you',
        notificationType: 'share',
    },
    [SSEventType.NOTIFICATION_CHANGED]: { type: SSEventType.NOTIFICATION_CHANGED },
    [SSEventType.CONTACT_CREATED]: contact(SSEventType.CONTACT_CREATED),
    [SSEventType.CONTACT_UPDATED]: contact(SSEventType.CONTACT_UPDATED),
    [SSEventType.CONTACT_DELETED]: contact(SSEventType.CONTACT_DELETED),
    [SSEventType.CONTACTS_CHANGED]: { type: SSEventType.CONTACTS_CHANGED },
    [SSEventType.LABEL_CREATED]: label(SSEventType.LABEL_CREATED),
    [SSEventType.LABEL_UPDATED]: label(SSEventType.LABEL_UPDATED),
    [SSEventType.LABEL_DELETED]: label(SSEventType.LABEL_DELETED),
    [SSEventType.BACKUP_JOB_UPDATED]: { type: SSEventType.BACKUP_JOB_UPDATED, jobId: 'job-1', ownerId: OWNER },
    [SSEventType.HOME_DATA_EPOCHS]: { type: SSEventType.HOME_DATA_EPOCHS, epochs: { [OWNER]: 'epoch-1' } },
};

// An event acts when it refetches a query, or, for the epochs, when the tab records the epochs it heard.
test('every event type reaches a handler that acts on it', () => {
    for (const event of Object.values(SAMPLES)) {
        window.sessionStorage.clear();
        const keys = invalidatedBy((queryClient) => handleSSEvent(event, queryClient, OWNER));
        const acted = keys.length > 0 || window.sessionStorage.length > 0;
        expect({ type: event.type, acted }).toEqual({ type: event.type, acted: true });
    }
});
