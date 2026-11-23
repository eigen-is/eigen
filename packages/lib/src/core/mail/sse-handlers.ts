// Handles the mail events from the stream, which always concern the signed-in user's own mail. Each
// refetches the message list it touched, and a burst of received mail every list once. As needed it also
// refetches the unread counts, the home size and the search results.

import type { QueryClient } from '@tanstack/react-query';
import type { SSEvent } from '@workspace/lib/types/sse';
import { SSEventType } from '@workspace/lib/types/sse';
import { debouncePerOwner } from '../debounce-per-owner';
import { invalidateHomeSize } from '../home';
import { invalidateSearchOwner } from '../search';
import {
    emailKeys,
    invalidateDraftUpdated,
    invalidateMailboxes,
    invalidateMailDeleted,
    invalidateMailMessageChanged,
    invalidateMailMoved,
} from './hooks/keys';
import { consumeRecentMailMutation } from './hooks/use-emails';

// A sync sends one mail:received per message, so the unread counts refetch once per burst, and every
// 1.5 s while a long sync goes on.
const invalidateMailboxesSoon = debouncePerOwner(invalidateMailboxes, 250, 1500);

// So do the message lists, the home size and the search a sync touches. The burst spans mailboxes, so it
// refetches every list of the owner, which costs nothing extra: only a list on screen refetches.
const invalidateReceivedSoon = debouncePerOwner(
    (queryClient, ownerId) => {
        queryClient.invalidateQueries({ queryKey: emailKeys.lists(ownerId) });
        invalidateHomeSize(queryClient, ownerId);
        invalidateSearchOwner(queryClient, ownerId);
    },
    250,
    1500,
);

export function handleMailSSEvent(event: SSEvent, queryClient: QueryClient, userId: string): void {
    if (!('mail' in event)) return;
    const { messageId, mailbox, toMailbox } = event.mail;

    switch (event.type) {
        case SSEventType.MAIL_RECEIVED:
            invalidateReceivedSoon(queryClient, userId);
            invalidateMailboxesSoon(queryClient, userId);
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
