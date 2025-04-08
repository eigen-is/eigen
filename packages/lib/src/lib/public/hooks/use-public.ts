import {useQuery} from '@tanstack/react-query';
import {spaceApi} from '@workspace/lib/api';

// Query keys for public user data
const publicUserKeys = {
    all: ['publicUser'] as const,
    details: () => [...publicUserKeys.all, 'detail'] as const,
    detail: (id: string) => [...publicUserKeys.details(), id] as const,
};

// Hook to fetch public user data
export function usePublicUser(emailOrId: string | undefined, options: { enabled: boolean } = {enabled: true}) {
    return useQuery({
        queryKey: publicUserKeys.detail(emailOrId || ''),
        queryFn: async () => {
            if (!emailOrId) return null;
            // check if emailOrId is an email adress
            const isEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailOrId);
            if (isEmail && !emailOrId.endsWith('@eigen.is')) return null;

            const res = await spaceApi.public[emailOrId].get();

            return res.data;
        },
        enabled: !!emailOrId && options.enabled,
        staleTime: 15 * 60 * 1000, // Consider data fresh for 15 minutes
    });
}