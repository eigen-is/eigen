import type { QueryClient } from '@tanstack/react-query';
import { debouncePerOwner } from '../../debounce-per-owner';

// Define query keys for reuse
export const homeKeys = {
    all: ['home'] as const,
    owner: (ownerId: string) => [...homeKeys.all, ownerId] as const,
    size: (ownerId: string) => [...homeKeys.owner(ownerId), 'size'] as const,
    myTeams: (ownerId: string) => [...homeKeys.owner(ownerId), 'my-teams'] as const,
};

// A write settles asynchronously (an S3 sync, a maildir move), so the size is read well after it lands.
export const invalidateHomeSize = debouncePerOwner((queryClient, ownerId) => {
    queryClient.invalidateQueries({ queryKey: homeKeys.size(ownerId) });
}, 5000);

export function invalidateMyTeams(queryClient: QueryClient): void {
    queryClient.invalidateQueries({
        queryKey: homeKeys.all,
        predicate: (query) => query.queryKey.includes('my-teams'),
    });
}
