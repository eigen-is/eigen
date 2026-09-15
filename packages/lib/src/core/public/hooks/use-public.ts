import { useMutation, useQueries, useQuery } from '@tanstack/react-query';
import { publicApi } from '@workspace/lib/api';
import { parseOwnerId } from '@workspace/lib/types';
import { validateEmailAddress } from '@workspace/lib/validation';
import { toast } from 'sonner';
import type { PublicUser } from '../../../types/public';
import { AppError, onMutationError } from '../../api-error';
import { fetchPublicUser } from '../user-batcher';
import { publicKeys, publicUserKeys } from './keys';

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

// The one read of the server's hosted-mail flag: every Mail entry point gates on this, and a
// server that runs without the mail containers hides them all. Undefined until the config lands —
// entry points read that as on (`!== false`) so the common deployment never flashes a missing Mail
// app, while a fetch gate reads it as off (`=== true`).
export function useMailEnabled(): boolean | undefined {
    const { data } = usePublicConfig();
    return data?.mailEnabled;
}

export function useJoinWaitlist() {
    return useMutation({
        mutationFn: async (body: { email: string; notes: string }) => {
            const start = Date.now();
            const res = await publicApi.waitlist.post(body);
            if (res.error) throw new AppError(res);
            // Let the submit register as a deliberate action even when the server answers instantly.
            await new Promise((resolve) => setTimeout(resolve, Math.max(350 - (Date.now() - start), 0)));
            return res.data;
        },
        onSuccess: () => {
            toast.success('Joined the waitlist', { description: 'Thanks for signing up' });
        },
        onError: onMutationError,
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

export function usePublicUsers(emailsOrIds: string[]): Record<string, PublicUser> {
    return useQueries({
        queries: emailsOrIds.map((id) => ({
            queryKey: publicUserKeys.detail(id),
            queryFn: () => fetchPublicUser(id),
            enabled: !!id,
            staleTime: Infinity,
        })),
        // Why: combine memoizes with structural sharing, so the map stays referentially
        // stable across renders and consumer useMemos hold.
        combine: (results) => {
            const map: Record<string, PublicUser> = {};
            emailsOrIds.forEach((id, i) => {
                const user = results[i]?.data;
                if (user) map[id] = user;
            });
            return map;
        },
    });
}
