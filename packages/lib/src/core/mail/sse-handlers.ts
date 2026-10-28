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

// A sync sends one mail:received per message, so the unread counts refetch once per burst, and every
// 1.5 s while a long sync goes on. The message lists still refetch at once.
const invalidateMailboxesSoon = debouncePerOwner(invalidateMailboxes, 250, 1500);

export function handleMailSSEvent(event: SSEvent, queryClient: QueryClient, userId: string): void {
    if (!('mail' in event)) return;
    const { messageId, mailbox, toMailbox } = event.mail;

    switch (event.type) {
        case SSEventType.MAIL_RECEIVED:
            invalidateMailReceived(queryClient, userId, mailbox);
            invalidateMailboxesSoon(queryClient, userId);
            invalidateHomeSize(queryClient, userId);
            invalidateSearchOwner(queryClient, userId);
            break;

        // In the four cases below, the echo of this tab's own optimistic change skips the list refetch,
        // because the list is patched already. The rest still refetches.
        case SSEventType.MAIL_DELETED:
            if (!consumeRecentMailMutation(event.type, messageId)) {
                invalidateMailDeleted(queryClient, userId, messageId, mailbox);
            }
            invalidateMailboxesSoon(queryClient, userId);
            invalidateHomeSize(queryClient, userId);
            invalidateSearchOwner(queryClient, userId);
            break;

        case SSEventType.MAIL_MOVED:
            // This tab's own move patched the source list and refetched the target list already. A move
            // made elsewhere refetches both lists here.
            if (!consumeRecentMailMutation(event.type, messageId)) {
                invalidateMailMoved(queryClient, userId, messageId, mailbox, toMailbox ?? null);
            }
            invalidateMailboxesSoon(queryClient, userId);
            invalidateSearchOwner(queryClient, userId);
            break;

        case SSEventType.MAIL_READ_CHANGED:
            if (!consumeRecentMailMutation(event.type, messageId)) {
                invalidateMailMessageChanged(queryClient, userId, messageId, mailbox);
            }
            invalidateMailboxesSoon(queryClient, userId);
            // The palette shows an unread mail in bold, from the cached search response.
            invalidateSearchOwner(queryClient, userId);
            break;

        case SSEventType.MAIL_FLAGS_CHANGED:
            if (!consumeRecentMailMutation(event.type, messageId)) {
                invalidateMailMessageChanged(queryClient, userId, messageId, mailbox);
            }
            invalidateMailboxesSoon(queryClient, userId);
            invalidateSearchOwner(queryClient, userId);
            break;

        case SSEventType.MAIL_DRAFT_UPDATED:
            invalidateDraftUpdated(queryClient, userId, messageId);
            invalidateMailboxesSoon(queryClient, userId);
            invalidateHomeSize(queryClient, userId);
            invalidateSearchOwner(queryClient, userId);
            break;

        case SSEventType.MAIL_SENT:
            invalidateMailboxesSoon(queryClient, userId);
            invalidateHomeSize(queryClient, userId);
            invalidateSearchOwner(queryClient, userId);
            break;
    }
}
