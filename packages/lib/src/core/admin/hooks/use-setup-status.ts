import { useQuery } from '@tanstack/react-query';
import { setupApi } from '../../api';
import { adminKeys } from './keys';

export function useSetupStatus() {
    return useQuery({
        queryKey: adminKeys.setupStatus(),
        queryFn: async () => {
            const res = await setupApi.status.get();
            return res.data;
        },
        staleTime: 1000 * 60 * 5,
    });
}
