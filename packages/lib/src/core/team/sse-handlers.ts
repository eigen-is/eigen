import type { QueryClient } from '@tanstack/react-query';
import type { SSEvent } from '@workspace/lib/types/sse';
import { SSEventType } from '@workspace/lib/types/sse';
import { invalidateMyTeams } from '../home';
import { invalidateTeamSettings } from './hooks/keys';

export function handleTeamSSEvent(event: SSEvent, queryClient: QueryClient): boolean {
    if (!event?.type?.startsWith('team:')) return false;

    switch (event.type) {
        case SSEventType.TEAM_SETTINGS_UPDATED:
            invalidateTeamSettings(queryClient, event.teamId);
            invalidateMyTeams(queryClient);
            return true;

        default:
            return false;
    }
}
