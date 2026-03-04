import {useQuery} from '@tanstack/react-query';
import {publicApi} from '@workspace/lib/api';
import {validateEmailAddress} from "@workspace/lib/validation";
import {parseOwnerId} from "@workspace/lib/types";

const publicKeys = {
    config: ['publicConfig'] as const,
};

const publicUserKeys = {
    all: ['publicUser'] as const,
    details: () => [...publicUserKeys.all, 'detail'] as const,
    detail: (id: string) => [...publicUserKeys.details(), id] as const,
};

export function usePublicConfig() {
    return useQuery({
        queryKey: publicKeys.config,
        queryFn: async () => {
            const res = await publicApi.config.get();
            return res.data;
        },
        staleTime: Infinity,
    });
}

export function usePublicUser(emailOrId: string | undefined) {
    return useQuery({
        queryKey: publicUserKeys.detail(emailOrId || ''),
        queryFn: async () => {
            if (!emailOrId || !(validateEmailAddress(emailOrId) || parseOwnerId(emailOrId).id)) return null;
            const res = await publicApi.user({emailOrId}).get();
            return res.data;
        },
        enabled: !!emailOrId,
        staleTime: Infinity
    });
}