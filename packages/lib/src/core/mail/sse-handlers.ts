import type {QueryClient} from '@tanstack/react-query';
import type {SSEvent} from '@workspace/lib/types/sse';
import {SSEventType} from '@workspace/lib/types/sse';
import {
    invalidateDraftUpdated,
    invalidateMailDeleted,
    invalidateMailFlagsChanged,
    invalidateMailMoved,
    invalidateMailReadChanged,
    invalidateMailReceived
} from './hooks/use-emails';
import {invalidateMailboxes} from './hooks/use-mailboxes';
import {invalidateHomeSize} from '../home';

const normalizeMailbox = (mailbox: string) => mailbox === '' ? 'inbox' : mailbox;

export function handleMailSSEvent(event: SSEvent, queryClient: QueryClient, userId: string): boolean {
    if (!event?.type?.startsWith('mail:')) return false;
    if (!('mail' in event)) return false;

    const {mail} = event;
    const mailbox = normalizeMailbox(mail.mailbox);

    switch (event.type) {
        case SSEventType.MAIL_RECEIVED:
            invalidateMailReceived(queryClient, userId, mailbox);
            invalidateMailboxes(queryClient, userId);
            invalidateHomeSize(queryClient, userId);
            return true;

        case SSEventType.MAIL_DELETED:
            invalidateMailDeleted(queryClient, userId, mail.messageId, mailbox);
            invalidateMailboxes(queryClient, userId);
            invalidateHomeSize(queryClient, userId);
            return true;

        case SSEventType.MAIL_MOVED: {
            const toMailbox = mail.toMailbox != null ? normalizeMailbox(mail.toMailbox) : null;
            invalidateMailMoved(queryClient, userId, mail.messageId, mailbox, toMailbox);
            invalidateMailboxes(queryClient, userId);
            return true;
        }

        case SSEventType.MAIL_READ_CHANGED:
            invalidateMailReadChanged(queryClient, userId, mail.messageId, mailbox);
            invalidateMailboxes(queryClient, userId);
            return true;

        case SSEventType.MAIL_FLAGS_CHANGED:
            invalidateMailFlagsChanged(queryClient, userId, mail.messageId, mailbox);
            return true;

        case SSEventType.MAIL_DRAFT_UPDATED:
            invalidateDraftUpdated(queryClient, userId, mail.messageId);
            invalidateMailboxes(queryClient, userId);
            invalidateHomeSize(queryClient, userId);
            return true;

        case SSEventType.MAIL_SENT:
            invalidateMailboxes(queryClient, userId);
            invalidateHomeSize(queryClient, userId);
            return true;

        default:
            return false;
    }
}
