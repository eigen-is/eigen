import { useQuery } from '@tanstack/react-query';
import { setupApi } from '../../api';
import { adminKeys } from './keys';

export type SetupStatus = { setupRequired: boolean; domain?: string };

export function useSetupStatus() {
    return useQuery<SetupStatus>({
        queryKey: adminKeys.setupStatus(),
        queryFn: async () => {
            const res = await setupApi.status.get();
            return res.data as SetupStatus;
        },
        staleTime: 1000 * 60 * 5,
    });
}
