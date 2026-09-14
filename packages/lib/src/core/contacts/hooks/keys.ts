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

// The owner-wide half of every contact change: the list every surface reads, the self/profile card (it
// reads through contactKeys.me, not the detail/list keys, and any card can claim the self-link), and the
// home size contacts count against. Its own export so the SSE handler can collapse it across a burst while
// each card's detail entry still updates at once.
export function invalidateContactList(queryClient: QueryClient, ownerId: string): void {
    queryClient.invalidateQueries({ queryKey: contactKeys.lists(ownerId) });
    queryClient.invalidateQueries({ queryKey: contactKeys.me(ownerId) });
    invalidateHomeSize(queryClient, ownerId);
}

export function invalidateContactUpdated(queryClient: QueryClient, ownerId: string, contactId: string): void {
    queryClient.invalidateQueries({ queryKey: contactKeys.detail(ownerId, contactId) });
    invalidateContactList(queryClient, ownerId);
}

export function invalidateContactDeleted(queryClient: QueryClient, ownerId: string, contactId: string): void {
    queryClient.removeQueries({ queryKey: contactKeys.detail(ownerId, contactId) });
    invalidateContactList(queryClient, ownerId);
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
