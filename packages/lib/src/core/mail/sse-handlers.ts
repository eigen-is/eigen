// Handles the mail events from the stream, which always concern the signed-in user's own mail. Each
// refetches the message list it touched and, as needed, the unread counts, the home size and the search
// results.

import type { QueryClient } from '@tanstack/react-query';
import type { SSEvent } from '@workspace/lib/types/sse';
import { SSEventType } from '@workspace/lib/types/sse';
import { debouncePerOwner } from '../debounce-per-owner';
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

// Debounced for the one mail:received per message a sync broadcasts; the message-list invalidations still land at once.
const invalidateMailboxesSoon = debouncePerOwner(invalidateMailboxes, 250);

export function handleMailSSEvent(event: SSEvent, queryClient: QueryClient, userId: string): boolean {
    if (!event?.type?.startsWith('mail:')) return false;
    if (!('mail' in event)) return false;

    const { mail } = event;
    const { mailbox } = mail;

    switch (event.type) {
        case SSEventType.MAIL_RECEIVED:
            invalidateMailReceived(queryClient, userId, mailbox);
            invalidateMailboxesSoon(queryClient, userId);
            invalidateHomeSize(queryClient, userId);
            invalidateSearchOwner(queryClient, userId);
            return true;

        // In the four cases below, the echo of this tab's own optimistic change skips the list refetch,
        // since the list is patched already. The counts, the search and the home size still refetch.

        case SSEventType.MAIL_DELETED:
            if (!consumeRecentMailMutation(event.type, mail.messageId)) {
                invalidateMailDeleted(queryClient, userId, mail.messageId, mailbox);
            }
            invalidateMailboxesSoon(queryClient, userId);
            invalidateHomeSize(queryClient, userId);
            invalidateSearchOwner(queryClient, userId);
            return true;

        case SSEventType.MAIL_MOVED: {
            // This tab's own move patched the source list and refetched the target list already. A move
            // made elsewhere refetches both lists here.
            if (!consumeRecentMailMutation(event.type, mail.messageId)) {
                invalidateMailMoved(queryClient, userId, mail.messageId, mailbox, mail.toMailbox ?? null);
            }
            invalidateMailboxesSoon(queryClient, userId);
            invalidateSearchOwner(queryClient, userId);
            return true;
        }

        case SSEventType.MAIL_READ_CHANGED:
            if (!consumeRecentMailMutation(event.type, mail.messageId)) {
                invalidateMailMessageChanged(queryClient, userId, mail.messageId, mailbox);
            }
            invalidateMailboxesSoon(queryClient, userId);
            // The palette shows an unread mail in bold, from the cached search response.
            invalidateSearchOwner(queryClient, userId);
            return true;

        case SSEventType.MAIL_FLAGS_CHANGED:
            if (!consumeRecentMailMutation(event.type, mail.messageId)) {
                invalidateMailMessageChanged(queryClient, userId, mail.messageId, mailbox);
            }
            invalidateMailboxesSoon(queryClient, userId);
            invalidateSearchOwner(queryClient, userId);
            return true;

        case SSEventType.MAIL_DRAFT_UPDATED:
            invalidateDraftUpdated(queryClient, userId, mail.messageId);
            invalidateMailboxesSoon(queryClient, userId);
            invalidateHomeSize(queryClient, userId);
            invalidateSearchOwner(queryClient, userId);
            return true;

        case SSEventType.MAIL_SENT:
            invalidateMailboxesSoon(queryClient, userId);
            invalidateHomeSize(queryClient, userId);
            invalidateSearchOwner(queryClient, userId);
            return true;

        default:
            return false;
    }
}
