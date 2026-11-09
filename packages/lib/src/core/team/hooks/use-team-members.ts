// Reads the members of one team, for screens such as the admin team page and the owner popover.
// A caller may not know its team yet, so the query waits until a team id arrives.

import { skipToken, useQuery } from '@tanstack/react-query';
import { teamApi } from '@workspace/lib/api';
import { STALE_TIME } from '@workspace/lib/constants/stale-time';
import { teamOwnerId } from '@workspace/lib/types';
import { AppError } from '../../api-error';
import { teamKeys } from './keys';

export function useTeamMembers(teamId: string | undefined) {
    return useQuery({
        queryKey: teamKeys.members(teamId ?? ''),
        queryFn: teamId
            ? async () => {
                  const res = await teamApi({ ownerId: teamOwnerId(teamId) }).members.get();
                  if (res.error) throw new AppError(res);
                  return res.data;
              }
            : skipToken,
        staleTime: STALE_TIME.TWO_MINUTES,
    });
}
