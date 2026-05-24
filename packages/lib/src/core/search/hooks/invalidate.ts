import type { QueryClient } from '@tanstack/react-query';
import { searchKeys } from '../keys';

export function invalidateSearchOwner(queryClient: QueryClient, ownerId: string): void {
    queryClient.invalidateQueries({ queryKey: searchKeys.owner(ownerId) });
}
