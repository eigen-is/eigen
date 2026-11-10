// The signup page's two calls for an invite link: check that the link's token is still valid, then
// register the new account with it. Both go through the public API, before anyone is signed in.

import { skipToken, useMutation, useQuery } from '@tanstack/react-query';
import { publicApi } from '../../api';
import { AppError, onMutationError } from '../../api-error';
import { inviteKeys } from './keys';

export function useValidateInviteToken(token: string | undefined) {
    return useQuery({
        queryKey: inviteKeys.validate(token),
        queryFn: token
            ? async () => {
                  const res = await publicApi.invite({ token }).get();
                  if (res.error) throw new AppError(res);
                  return res.data;
              }
            : skipToken,
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
