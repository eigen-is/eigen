import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { settingsApi } from '@workspace/lib/api';
import { STALE_TIME } from '@workspace/lib/constants/stale-time';
import type { ServerSettings } from '@workspace/lib/types/settings';
import type { DeepPartial } from '@workspace/lib/types/util';
import { toast } from 'sonner';
import { AppError, onMutationError } from '../../api-error';
import { invalidateServerSettings, settingsKeys } from './keys';

export function useServerSettings() {
    return useQuery({
        queryKey: settingsKeys.server(),
        queryFn: async () => {
            const res = await settingsApi.server.get();
            if (res.error) throw new AppError(res);
            return res.data;
        },
        staleTime: STALE_TIME.FIVE_MINUTES,
    });
}

export function useUpdateServerSettings() {
    const queryClient = useQueryClient();

    return useMutation({
        mutationFn: async (body: DeepPartial<ServerSettings>) => {
            const res = await settingsApi.server.put(body);
            if (res.error) throw new AppError(res);
            return res.data;
        },
        onSuccess: () => {
            invalidateServerSettings(queryClient);
            toast.success('Server settings saved');
        },
        onError: onMutationError,
    });
}
