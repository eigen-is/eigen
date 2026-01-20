import type {QueryClient} from '@tanstack/react-query';
import type {SSEvent} from '@workspace/lib/types/sse';
import {SSEventType} from '@workspace/lib/types/sse';
import {
    invalidateMailReceived,
    invalidateMailDeleted,
    invalidateMailMoved,
    invalidateMailReadChanged,
    invalidateDraftUpdated
} from './hooks/use-emails';
import {invalidateMailboxes} from './hooks/use-mailboxes';
import {invalidateHomeSize} from '../home';

const normalizeMailbox = (mailbox: string) => mailbox === '' ? 'inbox' : mailbox;

export function handleMailSSEvent(event: SSEvent, queryClient: QueryClient): boolean {
    if (!event.type.startsWith('mail:')) return false;
    if (!('mail' in event)) return false;

    const {mail} = event;
    const mailbox = normalizeMailbox(mail.mailbox);

    switch (event.type) {
        case SSEventType.MAIL_RECEIVED:
            invalidateMailReceived(queryClient);
            invalidateMailboxes(queryClient);
            invalidateHomeSize(queryClient);
            return true;

        case SSEventType.MAIL_DELETED:
            invalidateMailDeleted(queryClient, mail.messageId, mailbox);
            invalidateMailboxes(queryClient);
            invalidateHomeSize(queryClient);
            return true;

        case SSEventType.MAIL_MOVED: {
            const toMailbox = mail.toMailbox != null ? normalizeMailbox(mail.toMailbox) : null;
            invalidateMailMoved(queryClient, mail.messageId, mailbox, toMailbox);
            invalidateMailboxes(queryClient);
            return true;
        }

        case SSEventType.MAIL_READ_CHANGED:
            invalidateMailReadChanged(queryClient, mail.messageId, mailbox);
            invalidateMailboxes(queryClient);
            return true;

        case SSEventType.MAIL_DRAFT_UPDATED:
            invalidateDraftUpdated(queryClient, mail.messageId);
            invalidateMailboxes(queryClient);
            invalidateHomeSize(queryClient);
            return true;

        case SSEventType.MAIL_SENT:
            return true;

        default:
            return false;
    }
}
