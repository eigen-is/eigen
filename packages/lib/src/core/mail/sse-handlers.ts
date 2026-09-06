import type { QueryClient } from '@tanstack/react-query';
import type { SSEvent } from '@workspace/lib/types/sse';
import { SSEventType } from '@workspace/lib/types/sse';
import { invalidateHomeSize } from '../home';
import { invalidateSearchOwner } from '../search';
import {
    invalidateDraftUpdated,
    invalidateMailboxes,
    invalidateMailDeleted,
    invalidateMailMessageChanged,
    invalidateMailMoved,
    invalidateMailReceived,
} from './hooks/keys';
import { consumeRecentMailMutation } from './hooks/use-emails';

const normalizeMailbox = (mailbox: string) => (mailbox === '' ? 'inbox' : mailbox);

export function handleMailSSEvent(event: SSEvent, queryClient: QueryClient, userId: string): boolean {
    if (!event?.type?.startsWith('mail:')) return false;
    if (!('mail' in event)) return false;

    const { mail } = event;
    const mailbox = normalizeMailbox(mail.mailbox);

    switch (event.type) {
        case SSEventType.MAIL_RECEIVED:
            invalidateMailReceived(queryClient, userId, mailbox);
            invalidateMailboxes(queryClient, userId);
            invalidateHomeSize(queryClient, userId);
            invalidateSearchOwner(queryClient, userId);
            return true;

        // For the four cases below, skip the list refetch when this is the echo of our own optimistic
        // mutation (the list is already patched); the cheap counts/search/home invalidations still run.

        case SSEventType.MAIL_DELETED:
            if (!consumeRecentMailMutation(event.type, mail.messageId)) {
                invalidateMailDeleted(queryClient, userId, mail.messageId, mailbox);
            }
            invalidateMailboxes(queryClient, userId);
            invalidateHomeSize(queryClient, userId);
            invalidateSearchOwner(queryClient, userId);
            return true;

        case SSEventType.MAIL_MOVED: {
            // Own move: source list already patched + target list invalidated in the mutation onSuccess,
            // so skip the echo. A move by another client (no registry entry) invalidates both lists here.
            if (!consumeRecentMailMutation(event.type, mail.messageId)) {
                const toMailbox = mail.toMailbox != null ? normalizeMailbox(mail.toMailbox) : null;
                invalidateMailMoved(queryClient, userId, mail.messageId, mailbox, toMailbox);
            }
            invalidateMailboxes(queryClient, userId);
            invalidateSearchOwner(queryClient, userId);
            return true;
        }

        case SSEventType.MAIL_READ_CHANGED:
            if (!consumeRecentMailMutation(event.type, mail.messageId)) {
                invalidateMailMessageChanged(queryClient, userId, mail.messageId, mailbox);
            }
            invalidateMailboxes(queryClient, userId);
            // Palette mail rows carry isRead on the EmailSummary and bold-on-unread —
            // invalidate so the cached search response reflects the new flag.
            invalidateSearchOwner(queryClient, userId);
            return true;

        case SSEventType.MAIL_FLAGS_CHANGED:
            if (!consumeRecentMailMutation(event.type, mail.messageId)) {
                invalidateMailMessageChanged(queryClient, userId, mail.messageId, mailbox);
            }
            invalidateSearchOwner(queryClient, userId);
            return true;

        case SSEventType.MAIL_DRAFT_UPDATED:
            invalidateDraftUpdated(queryClient, userId, mail.messageId);
            invalidateMailboxes(queryClient, userId);
            invalidateHomeSize(queryClient, userId);
            invalidateSearchOwner(queryClient, userId);
            return true;

        case SSEventType.MAIL_SENT:
            invalidateMailboxes(queryClient, userId);
            invalidateHomeSize(queryClient, userId);
            invalidateSearchOwner(queryClient, userId);
            return true;

        default:
            return false;
    }
}
