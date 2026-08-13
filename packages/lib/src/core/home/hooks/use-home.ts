import { useQuery } from '@tanstack/react-query';
import { homeApi } from '@workspace/lib/api';
import { useAuth } from '@workspace/lib/auth';
import { STALE_TIME } from '@workspace/lib/constants/stale-time';
import { AppError } from '../../api-error';
import { homeKeys } from './keys';

// Hook to fetch home storage size information
export function useHomeSize() {
    const { user } = useAuth();
    const ownerId = user?.id || '';

    return useQuery({
        queryKey: homeKeys.size(ownerId),
        queryFn: async () => {
            const response = await homeApi({ ownerId }).size.get();
            if (response.error) throw new AppError(response);
            return response.data;
        },
        staleTime: STALE_TIME.FIVE_MINUTES,
        enabled: !!ownerId,
    });
}

export function useMyTeams() {
    const { user } = useAuth();
    const ownerId = user?.id || '';

    return useQuery({
        queryKey: homeKeys.myTeams(ownerId),
        queryFn: async () => {
            const response = await homeApi({ ownerId })['my-teams'].get();
            if (response.error) throw new AppError(response);
            return response.data;
        },
        staleTime: STALE_TIME.TWO_MINUTES,
        enabled: !!ownerId,
    });
}
