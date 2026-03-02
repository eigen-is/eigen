import {useQuery} from '@tanstack/react-query';
import {publicApi} from '@workspace/lib/api';

const publicUserKeys = {
    all: ['publicUser'] as const,
    details: () => [...publicUserKeys.all, 'detail'] as const,
    detail: (id: string) => [...publicUserKeys.details(), id] as const,
};

export function usePublicUser(emailOrId: string | undefined) {
    return useQuery({
        queryKey: publicUserKeys.detail(emailOrId || ''),
        queryFn: async () => {
            if (!emailOrId) return null;
            const res = await publicApi.user({emailOrId}).get();
            return res.data;
        },
        enabled: !!emailOrId,
        staleTime: Infinity
    });
}