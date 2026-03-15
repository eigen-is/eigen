import type {QueryClient} from '@tanstack/react-query';
import type {SSEvent} from '@workspace/lib/types/sse';
import {SSEventType} from '@workspace/lib/types/sse';
import {invalidateAllTeamSettings} from './hooks/use-team-settings';
import {calendarKeys} from '../calendar/hooks/use-calendar';

export function handleTeamSSEvent(event: SSEvent, queryClient: QueryClient): boolean {
    if (!event?.type?.startsWith('team:')) return false;

    switch (event.type) {
        case SSEventType.TEAM_SETTINGS_UPDATED:
            invalidateAllTeamSettings(queryClient);
            queryClient.invalidateQueries({queryKey: calendarKeys.sharedCalendars()});
            return true;

        default:
            return false;
    }
}
