import { useQuery } from '@tanstack/react-query';
import { mailApi } from '@workspace/lib/api';
import { useAuth } from '@workspace/lib/auth';
import { isStandardMailbox } from '@workspace/lib/constants/mailboxes';
import { STALE_TIME } from '@workspace/lib/constants/stale-time';
import { AppError } from '../../api-error';
import { usePublicConfig } from '../../public';
import { mailboxKeys } from './keys';

// Off until the config says mail is on: the route still mounts (a bookmark lands there) and would
// otherwise fetch and retry a mailbox list no backend serves.
export function useMailboxes() {
    const { user } = useAuth();
    const ownerId = user?.id || '';
    // Not useMailEnabled(): that reads a pending config as on, and a mail-off server must never be asked.
    const { data: config } = usePublicConfig();

    return useQuery({
        queryKey: mailboxKeys.lists(ownerId),
        queryFn: async () => {
            const response = await mailApi({ ownerId }).mailboxes.get();
            if (response.error) throw new AppError(response);
            return response.data;
        },
        staleTime: STALE_TIME.ONE_MINUTE,
        // A folder outside the standard six has no file watcher: each listing reconciles it server-side.
        refetchInterval: (query) =>
            query.state.data?.some((mailbox) => !isStandardMailbox(mailbox.path)) ? STALE_TIME.ONE_MINUTE : false,
        retry: 1,
        enabled: config?.mailEnabled === true && !!ownerId,
    });
}
