import type { QueryClient } from '@tanstack/react-query';
import { invalidateHomeSize } from '../../home';

export const contactKeys = {
    all: ['contacts'] as const,
    owner: (ownerId: string) => [...contactKeys.all, ownerId] as const,
    lists: (ownerId: string) => [...contactKeys.owner(ownerId), 'list'] as const,
    me: (ownerId: string) => [...contactKeys.owner(ownerId), 'me'] as const,
};

export const labelKeys = {
    all: ['labels'] as const,
    owner: (ownerId: string) => [...labelKeys.all, ownerId] as const,
    lists: (ownerId: string) => [...labelKeys.owner(ownerId), 'list'] as const,
};

// Invalidation functions (ownerId-scoped)

// The whole of a contact change: the list every surface reads (the detail pane renders from it), the
// self/profile card (it reads through contactKeys.me, and any card can claim the self-link), and the home
// size contacts count against. Its own export so the SSE handler can collapse it across a burst.
export function invalidateContactList(queryClient: QueryClient, ownerId: string): void {
    queryClient.invalidateQueries({ queryKey: contactKeys.lists(ownerId) });
    queryClient.invalidateQueries({ queryKey: contactKeys.me(ownerId) });
    invalidateHomeSize(queryClient, ownerId);
}

export function invalidateLabelCreated(queryClient: QueryClient, ownerId: string): void {
    queryClient.invalidateQueries({ queryKey: labelKeys.lists(ownerId) });
}

// A rename or a delete changes what every member card shows, so the contact list goes with the label list.
export function invalidateLabelChanged(queryClient: QueryClient, ownerId: string): void {
    queryClient.invalidateQueries({ queryKey: labelKeys.lists(ownerId) });
    queryClient.invalidateQueries({ queryKey: contactKeys.lists(ownerId) });
}
