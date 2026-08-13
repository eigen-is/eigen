import type { QueryClient } from '@tanstack/react-query';

export const chatKeys = {
    all: ['chat'] as const,
    owner: (ownerId: string) => [...chatKeys.all, ownerId] as const,
    messages: (ownerId: string, mountId: string, chatId: string) =>
        [...chatKeys.owner(ownerId), 'messages', mountId, chatId] as const,
    byMembersAll: (ownerId: string) => [...chatKeys.owner(ownerId), 'by-members'] as const,
    // Lowercased + sorted so member order and case don't fork the cache entry.
    byMembers: (ownerId: string, emails: string[]) =>
        [...chatKeys.byMembersAll(ownerId), emails.map((e) => e.toLowerCase()).sort()] as const,
};

export const commentKeys = {
    all: ['comments'] as const,
    owner: (ownerId: string) => [...commentKeys.all, ownerId] as const,
    container: (ownerId: string, mountId: string, containerId: string) =>
        [...commentKeys.owner(ownerId), mountId, containerId] as const,
    list: (ownerId: string, mountId: string, containerId: string) =>
        [...commentKeys.container(ownerId, mountId, containerId), 'list'] as const,
};

// SSE invalidation functions
export function invalidateMessages(queryClient: QueryClient, ownerId: string, mountId: string, chatId: string): void {
    queryClient.invalidateQueries({ queryKey: chatKeys.messages(ownerId, mountId, chatId) });
}

// By-members matches derive from ACLs, breadcrumbs and liveness, which change via drive events —
// the drive SSE handler calls this so a cached lookup can't keep serving a trashed or re-shared
// chat for its 30s staleTime.
export function invalidateChatMatches(queryClient: QueryClient, ownerId: string): void {
    queryClient.invalidateQueries({ queryKey: chatKeys.byMembersAll(ownerId) });
}

export function invalidateComments(
    queryClient: QueryClient,
    ownerId: string,
    mountId: string,
    containerId: string,
): void {
    queryClient.invalidateQueries({ queryKey: commentKeys.container(ownerId, mountId, containerId) });
}
