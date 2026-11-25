// The query keys of what the server tells anyone, signed in or not: its public config and a user's public profile.
// publicKeys stays out of the domain barrel, since only lib's own hooks read the config.

import type { QueryClient } from '@tanstack/react-query';

export const publicKeys = {
    config: ['publicConfig'] as const,
};

// Every app reads the config, so a save that changes it, such as the organization's name, waits for the refetch.
export function invalidatePublicConfig(queryClient: QueryClient): Promise<void> {
    return queryClient.invalidateQueries({ queryKey: publicKeys.config });
}

export const publicUserKeys = {
    all: ['publicUser'] as const,
    details: () => [...publicUserKeys.all, 'detail'] as const,
    detail: (id: string) => [...publicUserKeys.details(), id] as const,
};
