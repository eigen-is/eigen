// The query keys of chat rooms and comment threads, and the invalidations the chat hooks and the SSE handlers call
// when a message, a thread or a room's sharing changes. Every key starts with the owner, so personal and team chats
// keep apart.

import type { QueryClient } from '@tanstack/react-query';

export const chatKeys = {
    all: ['chat'] as const,
    owner: (ownerId: string) => [...chatKeys.all, ownerId] as const,
    messages: (ownerId: string, mountId: string, chatId: string) =>
        [...chatKeys.owner(ownerId), 'messages', mountId, chatId] as const,
    byMembersAll: (ownerId: string) => [...chatKeys.owner(ownerId), 'by-members'] as const,
    // Lowercased and sorted, so member order and case don't split the cache entry.
    byMembers: (ownerId: string, emails: readonly string[]) =>
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

export function invalidateMessages(queryClient: QueryClient, ownerId: string, mountId: string, chatId: string): void {
    queryClient.invalidateQueries({ queryKey: chatKeys.messages(ownerId, mountId, chatId) });
}

// A match depends on sharing, folders and the trash, which drive events change, so a cached lookup would otherwise
// offer a trashed or re-shared chat until it goes stale.
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
