import { describe, expect, test } from 'bun:test';
import { QueryClient, QueryObserver } from '@tanstack/react-query';
import { invalidatePublicConfig, publicKeys } from '../../../../core/public/hooks/keys';
import { invalidatedBy } from '../../../invalidation';

describe('invalidatePublicConfig', () => {
    test('refreshes the public config', () => {
        expect(invalidatedBy((queryClient) => invalidatePublicConfig(queryClient))).toEqual([[...publicKeys.config]]);
    });

    // A save that awaits it settles once the page shows the new config, such as a renamed organization.
    test('settles once the shown config has refetched', async () => {
        const queryClient = new QueryClient();
        let fetches = 0;
        const observer = new QueryObserver(queryClient, {
            queryKey: publicKeys.config,
            queryFn: async () => {
                fetches += 1;
                await new Promise((resolve) => setTimeout(resolve, 10));
                return fetches;
            },
        });
        const unsubscribe = observer.subscribe(() => {});
        await new Promise((resolve) => setTimeout(resolve, 20));

        await invalidatePublicConfig(queryClient);
        expect(observer.getCurrentResult().data).toBe(2);
        unsubscribe();
    });
});
