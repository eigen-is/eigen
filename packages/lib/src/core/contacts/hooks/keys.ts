import type { QueryClient } from '@tanstack/react-query';
import { invalidateHomeSize } from '../../home';

// Query keys for contacts
export const contactKeys = {
    all: ['contacts'] as const,
    owner: (ownerId: string) => [...contactKeys.all, ownerId] as const,
    lists: (ownerId: string) => [...contactKeys.owner(ownerId), 'list'] as const,
    list: (ownerId: string, filters: Record<string, unknown>) => [...contactKeys.lists(ownerId), { filters }] as const,
    details: (ownerId: string) => [...contactKeys.owner(ownerId), 'detail'] as const,
    detail: (ownerId: string, id: string) => [...contactKeys.details(ownerId), id] as const,
    me: (ownerId: string) => [...contactKeys.owner(ownerId), 'me'] as const,
};

// Query keys for labels
export const labelKeys = {
    all: ['labels'] as const,
    owner: (ownerId: string) => [...labelKeys.all, ownerId] as const,
    lists: (ownerId: string) => [...labelKeys.owner(ownerId), 'list'] as const,
    list: (ownerId: string, filters: string) => [...labelKeys.lists(ownerId), { filters }] as const,
    details: (ownerId: string) => [...labelKeys.owner(ownerId), 'detail'] as const,
    detail: (ownerId: string, id: string) => [...labelKeys.details(ownerId), id] as const,
};

// Invalidation functions (ownerId-scoped, used from mutation onSuccess)
export function invalidateContactCreated(queryClient: QueryClient, ownerId: string): void {
    queryClient.invalidateQueries({ queryKey: contactKeys.lists(ownerId) });
    // A DAV-created card can claim the self-link (an external client PUTs your own contact), so a mounted
    // useMeContact must refetch — mirror invalidateContactUpdated, which invalidates `me` for the same reason.
    queryClient.invalidateQueries({ queryKey: contactKeys.me(ownerId) });
    invalidateHomeSize(queryClient, ownerId);
}

export function invalidateContactUpdated(queryClient: QueryClient, ownerId: string, contactId: string): void {
    queryClient.invalidateQueries({ queryKey: contactKeys.detail(ownerId, contactId) });
    queryClient.invalidateQueries({ queryKey: contactKeys.lists(ownerId) });
    // The self/profile card reads through contactKeys.me, not the detail/list keys — invalidate it too so a
    // 412 recovery (or any edit to your own card) refetches the profile editor's frozen etag snapshot.
    queryClient.invalidateQueries({ queryKey: contactKeys.me(ownerId) });
    invalidateHomeSize(queryClient, ownerId);
}

export function invalidateContactDeleted(queryClient: QueryClient, ownerId: string, contactId: string): void {
    queryClient.removeQueries({ queryKey: contactKeys.detail(ownerId, contactId) });
    queryClient.invalidateQueries({ queryKey: contactKeys.lists(ownerId) });
    invalidateHomeSize(queryClient, ownerId);
}

export function invalidateLabelCreated(queryClient: QueryClient, ownerId: string): void {
    queryClient.invalidateQueries({ queryKey: labelKeys.lists(ownerId) });
}

export function invalidateLabelUpdated(queryClient: QueryClient, ownerId: string, labelId: string): void {
    queryClient.invalidateQueries({ queryKey: labelKeys.detail(ownerId, labelId) });
    queryClient.invalidateQueries({ queryKey: labelKeys.lists(ownerId) });
    queryClient.invalidateQueries({ queryKey: contactKeys.lists(ownerId) });
}

export function invalidateLabelDeleted(queryClient: QueryClient, ownerId: string, labelId: string): void {
    queryClient.removeQueries({ queryKey: labelKeys.detail(ownerId, labelId) });
    queryClient.invalidateQueries({ queryKey: labelKeys.lists(ownerId) });
    queryClient.invalidateQueries({ queryKey: contactKeys.lists(ownerId) });
}
