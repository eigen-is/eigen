// The Calendar view a user last picked: a week on a computer and 3 days on a phone until they pick, each layout's own
// pick read back from their settings or, before those load, from this browser's copy, and a pick saved at once.
import { afterAll, describe, expect, mock, test } from 'bun:test';
import { QueryClient } from '@tanstack/react-query';
import type { UserSettings } from '@workspace/lib/types/settings';
import { deepMerge } from '../../../../core/deep-merge';
import { spaceKeys } from '../../../../core/space/hooks/keys';
import { installHappyDom } from '../../../happy-dom';
import { renderHook } from '../../../render-hook';

const window = installHappyDom();

const OWNER = 'u'.repeat(32);

const realAuthContextModule = await import('../../../../core/auth/auth-context');
mock.module('../../../../core/auth/auth-context', () => ({
    useAuth: () => ({ user: { id: OWNER, role: 'user' } }),
}));

const realApiModule = await import('../../../../core/api');
// The server's settings: a save deep-merges into them, as the route does, and a read returns them.
const saved: UserSettings[] = [];
let stored: UserSettings = {};
mock.module('../../../../core/api', () => ({
    ...realApiModule,
    spaceApi: () => ({
        settings: {
            get: async () => ({ data: stored, error: null, status: 200 }),
            put: async (body: UserSettings) => {
                saved.push(body);
                stored = deepMerge(stored, body);
                return { data: stored, error: null, status: 200 };
            },
        },
    }),
}));

afterAll(() => {
    mock.module('../../../../core/api', () => realApiModule);
    mock.module('../../../../core/auth/auth-context', () => realAuthContextModule);
});

const { useCalendarViewPreference } = await import('../../../../core/calendar/hooks/use-calendar-view-preference');
const { act } = await import('react');

function client(settings?: UserSettings): QueryClient {
    const queryClient = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
    if (settings) queryClient.setQueryData(spaceKeys.settings(OWNER), settings);
    return queryClient;
}

describe('useCalendarViewPreference', () => {
    test('is a week on a computer and 3 days on a phone with nothing stored or cached', async () => {
        window.localStorage.clear();
        stored = {};
        const desktop = await renderHook(() => useCalendarViewPreference(), client());
        expect(desktop.latest.mode).toBe('week');
        await desktop.unmount();
        window.happyDOM.setViewport({ width: 390, height: 844 });
        const phone = await renderHook(() => useCalendarViewPreference(), client());
        expect(phone.latest.mode).toBe('3day');
        await phone.unmount();
        window.happyDOM.setViewport({ width: 1440, height: 900 });
    });

    test("a pick saves for its own layout, keeps the other's, and is this browser's copy before the settings load", async () => {
        window.localStorage.clear();
        saved.length = 0;
        stored = { calendarView: { phone: 'day' } };
        const queryClient = client(stored);
        const desktop = await renderHook(() => useCalendarViewPreference(), queryClient);
        await act(async () => {
            desktop.latest.setMode('month');
        });
        expect(saved).toEqual([{ calendarView: { desktop: 'month' } }]);
        expect(queryClient.getQueryData<UserSettings>(spaceKeys.settings(OWNER))?.calendarView).toEqual({
            phone: 'day',
            desktop: 'month',
        });
        await desktop.unmount();

        stored = {};
        const reopened = await renderHook(() => useCalendarViewPreference(), client());
        expect(reopened.latest.mode).toBe('month');
        await reopened.unmount();
    });

    test('picking the stored view again saves nothing', async () => {
        window.localStorage.clear();
        saved.length = 0;
        stored = { calendarView: { desktop: 'week' } };
        const { latest, unmount } = await renderHook(() => useCalendarViewPreference(), client(stored));
        await act(async () => {
            latest.setMode('week');
        });
        expect(saved).toEqual([]);
        await unmount();
    });

    test('a pick of the default view saves while nothing is stored, so it is not lost to a pick on another device', async () => {
        window.localStorage.clear();
        saved.length = 0;
        stored = {};
        const { latest, unmount } = await renderHook(() => useCalendarViewPreference(), client());
        await act(async () => {
            latest.setMode('week');
        });
        expect(saved).toEqual([{ calendarView: { desktop: 'week' } }]);
        await unmount();
    });
});
