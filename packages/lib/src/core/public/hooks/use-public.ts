import { useQuery } from '@tanstack/react-query';
import { publicApi } from '@workspace/lib/api';
import { parseOwnerId } from '@workspace/lib/types';
import { validateEmailAddress } from '@workspace/lib/validation';
import { AppError } from '../../api-error';
import { fetchPublicUser } from '../user-batcher';

const publicKeys = {
    config: ['publicConfig'] as const,
};

export const publicUserKeys = {
    all: ['publicUser'] as const,
    details: () => [...publicUserKeys.all, 'detail'] as const,
    detail: (id: string) => [...publicUserKeys.details(), id] as const,
};

export function usePublicConfig() {
    return useQuery({
        queryKey: publicKeys.config,
        queryFn: async () => {
            const res = await publicApi.config.get();
            if (res.error) throw new AppError(res);
            return res.data;
        },
        staleTime: Infinity,
    });
}

export function usePublicUser(emailOrId: string | undefined) {
    return useQuery({
        queryKey: publicUserKeys.detail(emailOrId || ''),
        queryFn: () => fetchPublicUser(emailOrId!),
        enabled: !!emailOrId && !!(validateEmailAddress(emailOrId) || parseOwnerId(emailOrId).id),
        staleTime: Infinity,
    });
}
