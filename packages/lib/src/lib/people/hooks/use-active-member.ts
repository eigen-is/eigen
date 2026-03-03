import {useQuery} from '@tanstack/react-query';
import {authClient} from '../../auth/hooks/use-auth-client';
import {peopleKeys} from './keys.ts';

export function useActiveMember() {
    return useQuery({
        queryKey: peopleKeys.activeMember(),
        queryFn: async () => {
            const {data} = await authClient.organization.getActiveMember();
            return data ?? null;
        },
        staleTime: 1000 * 60 * 5,
    });
}
