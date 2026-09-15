import { useQuery } from '@tanstack/react-query';
import { mailApi } from '@workspace/lib/api';
import { useAuth } from '@workspace/lib/auth';
import { STALE_TIME } from '@workspace/lib/constants/stale-time';
import { AppError } from '../../api-error';
import { useMailEnabled } from '../../public';
import { mailboxKeys } from './keys';

// Off until the config says mail is on: the route still mounts (a bookmark lands there) and would
// otherwise fetch and retry a mailbox list no backend serves.
export function useMailboxes() {
    const { user } = useAuth();
    const ownerId = user?.id || '';
    const mailEnabled = useMailEnabled();

    return useQuery({
        queryKey: mailboxKeys.lists(ownerId),
        queryFn: async () => {
            const response = await mailApi({ ownerId }).mailboxes.get();
            if (response.error) throw new AppError(response);
            return response.data;
        },
        staleTime: STALE_TIME.ONE_MINUTE,
        retry: 1,
        enabled: mailEnabled === true && !!ownerId,
    });
}
