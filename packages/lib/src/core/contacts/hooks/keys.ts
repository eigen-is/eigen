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

// Define query keys for reuse
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
    invalidateHomeSize(queryClient, ownerId);
}

export function invalidateContactUpdated(queryClient: QueryClient, ownerId: string, contactId: string): void {
    queryClient.invalidateQueries({ queryKey: contactKeys.detail(ownerId, contactId) });
    queryClient.invalidateQueries({ queryKey: contactKeys.lists(ownerId) });
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
