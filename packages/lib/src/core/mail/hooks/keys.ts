import type { QueryClient } from '@tanstack/react-query';

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
        [...emailKeys.lists(ownerId), { mailbox: mailbox === '' ? 'inbox' : mailbox.toLowerCase() }] as const,
    details: (ownerId: string) => [...emailKeys.owner(ownerId), 'detail'] as const,
    detail: (ownerId: string, id: string) => [...emailKeys.details(ownerId), id] as const,
};

export const mailboxKeys = {
    all: ['mailboxes'] as const,
    owner: (ownerId: string) => [...mailboxKeys.all, ownerId] as const,
    lists: (ownerId: string) => [...mailboxKeys.owner(ownerId), 'list'] as const,
    list: (ownerId: string, filters: Record<string, unknown>) => [...mailboxKeys.lists(ownerId), { filters }] as const,
};

// Invalidation functions (ownerId-scoped, used from mutation onSuccess)
export function invalidateMailboxes(queryClient: QueryClient, ownerId: string): void {
    queryClient.invalidateQueries({ queryKey: mailboxKeys.lists(ownerId) });
}

export function invalidateMailReceived(queryClient: QueryClient, ownerId: string, mailbox: string = 'inbox'): void {
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

export function invalidateMailReadChanged(
    queryClient: QueryClient,
    ownerId: string,
    messageId: string,
    mailbox: string,
): void {
    queryClient.invalidateQueries({ queryKey: emailKeys.detail(ownerId, messageId) });
    queryClient.invalidateQueries({ queryKey: emailKeys.list(ownerId, mailbox) });
}

export function invalidateMailFlagsChanged(
    queryClient: QueryClient,
    ownerId: string,
    messageId: string,
    mailbox: string,
): void {
    queryClient.invalidateQueries({ queryKey: emailKeys.detail(ownerId, messageId) });
    queryClient.invalidateQueries({ queryKey: emailKeys.list(ownerId, mailbox) });
}

export function invalidateDraftUpdated(queryClient: QueryClient, ownerId: string, messageId: string): void {
    queryClient.invalidateQueries({ queryKey: emailKeys.list(ownerId, 'Drafts') });
    queryClient.invalidateQueries({ queryKey: emailKeys.detail(ownerId, messageId) });
}
