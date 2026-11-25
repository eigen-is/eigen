// A team's own settings, such as whether it has a calendar, whether access requests notify its members and the quota
// overrides it gives them. The admin's team page reads them here and saves them, with the team's name and calendar
// access, through one Save.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { calendarApi, teamApi } from '@workspace/lib/api';
import { STALE_TIME } from '@workspace/lib/constants/stale-time';
import { teamOwnerId } from '@workspace/lib/types';
import type { CalendarShare } from '@workspace/lib/types/calendar';
import type { TeamSettings } from '@workspace/lib/types/settings';
import { toast } from 'sonner';
import { invalidateAdminTeams, invalidateAdminUsers } from '../../admin/hooks/keys';
import { AppError, onMutationError } from '../../api-error';
import { authClient } from '../../auth/hooks/use-auth-client';
import { invalidateCalendarList } from '../../calendar/hooks/keys';
import { invalidateMyTeams } from '../../home';
import { invalidateTeamSettings, teamKeys } from './keys';

// A part left out is not written: the name when it is unchanged, the calendar when the team has none to share.
type TeamSettingsSave = {
    name?: string;
    calendar?: { id: string; shares: CalendarShare[] | null };
    settings: TeamSettings;
};

export function useTeamSettings(teamId: string) {
    return useQuery({
        queryKey: teamKeys.settings(teamId),
        queryFn: async () => {
            const res = await teamApi({ ownerId: teamOwnerId(teamId) }).settings.get();
            if (res.error) throw new AppError(res);
            return res.data;
        },
        staleTime: STALE_TIME.FIVE_MINUTES,
        enabled: !!teamId,
    });
}

// The writes go one after another, so a refusal stops the rest and leaves the form open. Each is idempotent, so a
// retry sends them again, less the name once the renamed team has reloaded.
export function useSaveTeamSettings(teamId: string, organizationId?: string) {
    const queryClient = useQueryClient();
    const ownerId = teamOwnerId(teamId);

    return useMutation({
        mutationFn: async ({ name, calendar, settings }: TeamSettingsSave) => {
            if (name !== undefined) {
                const { error } = await authClient.organization.updateTeam({ teamId, data: { name } });
                if (error) throw new Error(error.message ?? 'Failed to rename the team');
                invalidateAdminTeams(queryClient, organizationId ?? '');
                invalidateMyTeams(queryClient);
                invalidateAdminUsers(queryClient);
            }
            if (calendar) {
                const res = await calendarApi({ ownerId })
                    .calendars({ calId: calendar.id })
                    .put({ shares: calendar.shares });
                if (res.error) throw new AppError(res);
                invalidateCalendarList(queryClient, ownerId);
            }
            const res = await teamApi({ ownerId }).settings.put(settings);
            if (res.error) throw new AppError(res);
            invalidateTeamSettings(queryClient, teamId);
        },
        onSuccess: () => toast.success('Team settings saved'),
        onError: onMutationError,
    });
}
