import type { QueryClient } from '@tanstack/react-query';
import { MAILBOX_DRAFTS, mailboxRouteSegment } from '@workspace/lib/constants/mailboxes';

export const emailKeys = {
    all: ['emails'] as const,
    owner: (ownerId: string) => [...emailKeys.all, ownerId] as const,
    lists: (ownerId: string) => [...emailKeys.owner(ownerId), 'list'] as const,
    // Normalize the mailbox so every spelling of a box maps to one key. toLowerCase() reconciles the
    // lowercase sidebar URLs (/box/sent) with the canonical-case SSE events ('Sent'); the ''→'inbox'
    // step reconciles the server-canonical inbox ('') that rides on EmailSummary.mailbox with the
    // 'inbox' the route mounts under. Without it, invalidating list(ownerId, '') on a move/undo INTO
    // the inbox would miss the open {mailbox:'inbox'} query and the row wouldn't reappear.
    list: (ownerId: string, mailbox: string) =>
        [...emailKeys.lists(ownerId), { mailbox: mailboxRouteSegment(mailbox) }] as const,
    details: (ownerId: string) => [...emailKeys.owner(ownerId), 'detail'] as const,
    detail: (ownerId: string, id: string) => [...emailKeys.details(ownerId), id] as const,
    // One attachment's server-rendered preview: the part index identifies it inside the message. Under
    // detail(), so a deleted message and a rewritten draft evict the previews of the parts they had.
    previews: (ownerId: string, messageId: string) =>
        [...emailKeys.detail(ownerId, messageId), 'attachment-preview'] as const,
    textPreview: (ownerId: string, messageId: string, index: number) =>
        [...emailKeys.previews(ownerId, messageId), 'text', index] as const,
    vcardPreview: (ownerId: string, messageId: string, index: number) =>
        [...emailKeys.previews(ownerId, messageId), 'vcard', index] as const,
};

export const mailboxKeys = {
    all: ['mailboxes'] as const,
    owner: (ownerId: string) => [...mailboxKeys.all, ownerId] as const,
    lists: (ownerId: string) => [...mailboxKeys.owner(ownerId), 'list'] as const,
};

// Invalidation functions (ownerId-scoped, used from mutation onSuccess)
export function invalidateMailboxes(queryClient: QueryClient, ownerId: string): void {
    queryClient.invalidateQueries({ queryKey: mailboxKeys.lists(ownerId) });
}

export function invalidateMailReceived(queryClient: QueryClient, ownerId: string, mailbox: string): void {
    queryClient.invalidateQueries({ queryKey: emailKeys.list(ownerId, mailbox) });
}

export function invalidateMailDeleted(
    queryClient: QueryClient,
    ownerId: string,
    messageId: string,
    mailbox: string,
): void {
    queryClient.removeQueries({ queryKey: emailKeys.detail(ownerId, messageId) });
    queryClient.invalidateQueries({ queryKey: emailKeys.list(ownerId, mailbox) });
}

export function invalidateMailMoved(
    queryClient: QueryClient,
    ownerId: string,
    messageId: string,
    fromMailbox: string,
    toMailbox: string | null | undefined,
): void {
    queryClient.invalidateQueries({ queryKey: emailKeys.detail(ownerId, messageId) });
    queryClient.invalidateQueries({ queryKey: emailKeys.list(ownerId, fromMailbox) });
    if (toMailbox) {
        queryClient.invalidateQueries({ queryKey: emailKeys.list(ownerId, toMailbox) });
    }
}

// Read and flag changes touch the same two keys: the message and the list it sits in.
export function invalidateMailMessageChanged(
    queryClient: QueryClient,
    ownerId: string,
    messageId: string,
    mailbox: string,
): void {
    queryClient.invalidateQueries({ queryKey: emailKeys.detail(ownerId, messageId) });
    queryClient.invalidateQueries({ queryKey: emailKeys.list(ownerId, mailbox) });
}

export function invalidateDraftUpdated(queryClient: QueryClient, ownerId: string, messageId: string): void {
    queryClient.invalidateQueries({ queryKey: emailKeys.list(ownerId, MAILBOX_DRAFTS) });
    queryClient.invalidateQueries({ queryKey: emailKeys.detail(ownerId, messageId) });
}
