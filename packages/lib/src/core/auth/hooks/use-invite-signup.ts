import { useMutation, useQuery } from '@tanstack/react-query';
import { publicApi } from '../../api';
import { AppError, onMutationError } from '../../api-error';

const inviteKeys = {
    all: ['invite'] as const,
    validate: (token: string | undefined) => [...inviteKeys.all, 'validate', token] as const,
};

export function useValidateInviteToken(token: string | undefined) {
    return useQuery({
        queryKey: inviteKeys.validate(token),
        queryFn: async () => {
            const res = await publicApi.invite({ token: token! }).get();
            if (res.error) throw new AppError(res);
            return res.data;
        },
        enabled: !!token,
        retry: false,
        staleTime: Infinity,
    });
}

export function useInviteRegister(token: string) {
    return useMutation({
        mutationFn: async (body: { name: string; username: string; password: string }) => {
            const res = await publicApi.invite({ token }).register.post(body);
            if (res.error) throw new AppError(res);
            return res.data;
        },
        onError: onMutationError,
    });
}
