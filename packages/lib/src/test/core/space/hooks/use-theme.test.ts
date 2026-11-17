// The theme: the computer's own setting for a browser with no copy, such as a guest's, Light for a user who never
// picked one, and what they picked read from their settings or, before those load, from this browser's copy. A pick
// draws at once and saves in the background, without a toast.
import { afterAll, beforeEach, expect, mock, test } from 'bun:test';
import { QueryClient } from '@tanstack/react-query';
import { THEME_COPY_KEY } from '@workspace/lib/constants/theme';
import type { UserSettings } from '@workspace/lib/types/settings';
import { themeOf } from '@workspace/lib/types/settings';
import { spaceKeys } from '../../../../core/space/hooks/keys';
import { installHappyDom } from '../../../happy-dom';
import { renderHook } from '../../../render-hook';

installHappyDom();

const OWNER = 'u'.repeat(32);
let role = 'user';

const realAuthContextModule = await import('../../../../core/auth/auth-context');
mock.module('../../../../core/auth/auth-context', () => ({
    useAuth: () => ({ user: { id: OWNER, role } }),
}));

// The server's settings. A save waits until the test lets it land, so the test sees what the page draws meanwhile.
const saved: UserSettings[] = [];
let stored: UserSettings = {};
let land = () => {};
const realApiModule = await import('../../../../core/api');
mock.module('../../../../core/api', () => ({
    ...realApiModule,
    spaceApi: () => ({
        settings: {
            get: async () => ({ data: stored, error: null, status: 200 }),
            put: async (body: UserSettings) => {
                saved.push(body);
                await new Promise<void>((resolve) => {
                    land = resolve;
                });
                stored = { ...stored, ...body };
                return { data: stored, error: null, status: 200 };
            },
        },
    }),
}));

const toasts: string[] = [];
const realSonner = { ...(await import('sonner')) };
mock.module('sonner', () => ({
    ...realSonner,
    toast: Object.assign((message: string) => toasts.push(message), {
        success: (message: string) => toasts.push(message),
        error: (message: string) => toasts.push(message),
    }),
}));

afterAll(() => {
    mock.module('../../../../core/api', () => realApiModule);
    mock.module('../../../../core/auth/auth-context', () => realAuthContextModule);
    mock.module('sonner', () => realSonner);
});

const { useTheme } = await import('../../../../core/space/hooks/use-theme');
const { act } = await import('react');

function client(settings?: UserSettings): QueryClient {
    const queryClient = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
    if (settings) queryClient.setQueryData(spaceKeys.settings(OWNER), settings);
    return queryClient;
}

beforeEach(() => {
    window.localStorage.clear();
    saved.length = 0;
    toasts.length = 0;
    stored = {};
    role = 'user';
});

test('follows the computer for a guest, who has no settings, and the saved theme once they hold one', async () => {
    role = 'guest';
    const guest = await renderHook(() => useTheme(), client());
    expect(guest.latest.theme).toBe('system');
    await guest.unmount();

    role = 'user';
    const loaded = await renderHook(() => useTheme(), client({ theme: 'dark' }));
    expect(loaded.latest.theme).toBe('dark');
    await loaded.unmount();
});

test('a user who never picked one is Light, and this browser keeps Light for next time', async () => {
    const { latest, unmount } = await renderHook(() => useTheme(), client({}));
    expect(latest.theme).toBe('light');
    expect(window.localStorage.getItem(THEME_COPY_KEY)).toBe('light');
    await unmount();
});

test('a pick draws before the save lands, and the save shows no toast', async () => {
    const queryClient = client({ theme: 'light' });
    const { latest, unmount } = await renderHook(() => useTheme(), queryClient);
    await act(async () => {
        latest.setTheme('dark');
    });
    expect(themeOf(queryClient.getQueryData(spaceKeys.settings(OWNER)))).toBe('dark');
    expect(window.localStorage.getItem(THEME_COPY_KEY)).toBe('dark');
    expect(saved).toEqual([{ theme: 'dark' }]);

    await act(async () => land());
    expect(toasts).toEqual([]);
    await unmount();
});

test('picking the theme already drawn saves nothing', async () => {
    const { latest, unmount } = await renderHook(() => useTheme(), client({ theme: 'dark' }));
    await act(async () => {
        latest.setTheme('dark');
    });
    expect(saved).toEqual([]);
    await unmount();
});

test("before the settings load, this browser's copy draws the theme", async () => {
    window.localStorage.setItem(THEME_COPY_KEY, 'system');
    const { latest, unmount } = await renderHook(() => useTheme(), client());
    expect(latest.theme).toBe('system');
    await unmount();
});
