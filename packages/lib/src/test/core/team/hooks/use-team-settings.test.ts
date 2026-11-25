// Team settings has one Save for the team's name, its default calendar's member access and its settings. The writes
// go one after another and say "Team settings saved" once; a refused write stops the ones after it and toasts only its
// error, and a retry sends them again. A name the form leaves out is not written.
import { afterAll, beforeEach, expect, mock, test } from 'bun:test';
import { teamOwnerId } from '@workspace/lib/types/owner';
import type { TeamSettings } from '@workspace/lib/types/settings';
import { renderHook } from '../../../render-hook';
import { hasKey, installTransferHarness, toasts, trackingClient } from '../../../transfer-harness';

installTransferHarness();

const TEAM = 't'.repeat(32);
const OWNER = teamOwnerId(TEAM);
const SETTINGS: TeamSettings = { calendar: { enabled: true }, notifyMembers: false, memberOverrides: {} };

// Each write the hook sends, in order, and the one the server refuses.
const writes: string[] = [];
let refuse = '';
const refused = { data: null, error: { status: 403, value: 'Not allowed' }, status: 403 };
const reply = (write: string) => {
    writes.push(write);
    return write === refuse ? refused : { data: {}, error: null, status: 200 };
};

const realAuthClientModule = await import('../../../../core/auth/hooks/use-auth-client');
const { authClient } = realAuthClientModule;
mock.module('../../../../core/auth/hooks/use-auth-client', () => ({
    ...realAuthClientModule,
    authClient: {
        ...authClient,
        organization: {
            ...authClient.organization,
            updateTeam: async ({ data }: { data: { name: string } }) => {
                writes.push(`name ${data.name}`);
                return refuse === 'name' ? { data: null, error: { message: 'Name taken' } } : { data: {}, error: null };
            },
        },
    },
}));
const realApiModule = await import('../../../../core/api');
mock.module('../../../../core/api', () => ({
    ...realApiModule,
    calendarApi: () => ({
        calendars: ({ calId }: { calId: string }) => ({ put: async () => reply(`share ${calId}`) }),
    }),
    teamApi: () => ({ settings: { put: async () => reply('settings') } }),
}));
afterAll(() => {
    mock.module('../../../../core/auth/hooks/use-auth-client', () => realAuthClientModule);
    mock.module('../../../../core/api', () => realApiModule);
});

const { act } = await import('react');
const { adminKeys } = await import('../../../../core/admin/hooks/keys');
const { calendarKeys } = await import('../../../../core/calendar/hooks/keys');
const { teamKeys } = await import('../../../../core/team/hooks/keys');
const { useSaveTeamSettings } = await import('../../../../core/team/hooks/use-team-settings');

beforeEach(() => {
    writes.length = 0;
    toasts.length = 0;
    refuse = '';
});

test('the name, the share and the settings are written in order, refreshed, and saved once', async () => {
    const { queryClient, invalidated } = trackingClient();
    const { latest, unmount } = await renderHook(() => useSaveTeamSettings(TEAM, 'org-1'), queryClient);
    await act(async () => {
        await latest.mutateAsync({ name: 'Design', calendar: { id: 'cal-1', shares: null }, settings: SETTINGS });
    });
    await unmount();

    expect(writes).toEqual(['name Design', 'share cal-1', 'settings']);
    expect(toasts).toEqual(['success: Team settings saved']);
    for (const key of [adminKeys.teams('org-1'), calendarKeys.calendarList(OWNER), teamKeys.settings(TEAM)]) {
        expect(hasKey(invalidated, key)).toBe(true);
    }
});

test('a name and calendar left out are not written', async () => {
    const { latest, unmount } = await renderHook(
        () => useSaveTeamSettings(TEAM, 'org-1'),
        trackingClient().queryClient,
    );
    await act(async () => {
        await latest.mutateAsync({ settings: SETTINGS });
    });
    await unmount();

    expect(writes).toEqual(['settings']);
    expect(toasts).toEqual(['success: Team settings saved']);
});

test('a refused share stops the settings write and toasts only its error; a retry sends both again', async () => {
    refuse = 'share cal-1';
    const { latest, unmount } = await renderHook(
        () => useSaveTeamSettings(TEAM, 'org-1'),
        trackingClient().queryClient,
    );
    const save = { calendar: { id: 'cal-1', shares: null }, settings: SETTINGS };
    await act(async () => {
        await latest.mutateAsync(save).catch(() => {});
    });
    expect(writes).toEqual(['share cal-1']);
    expect(toasts).toEqual(['error: Not allowed']);

    refuse = '';
    toasts.length = 0;
    await act(async () => {
        await latest.mutateAsync(save);
    });
    await unmount();
    expect(writes).toEqual(['share cal-1', 'share cal-1', 'settings']);
    expect(toasts).toEqual(['success: Team settings saved']);
});

test('a refused rename stops the share and settings writes and toasts only its error, once', async () => {
    refuse = 'name';
    const { queryClient, invalidated } = trackingClient();
    const { latest, unmount } = await renderHook(() => useSaveTeamSettings(TEAM, 'org-1'), queryClient);
    await act(async () => {
        await latest
            .mutateAsync({ name: 'Design', calendar: { id: 'cal-1', shares: null }, settings: SETTINGS })
            .catch(() => {});
    });
    await unmount();

    expect(writes).toEqual(['name Design']);
    expect(toasts).toEqual(['error: Name taken']);
    expect(hasKey(invalidated, teamKeys.settings(TEAM))).toBe(false);
});
