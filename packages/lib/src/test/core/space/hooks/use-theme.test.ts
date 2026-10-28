// The theme: Light until the user picks one, what they picked read from their settings or, before those load, from
// this browser's copy. A pick draws at once and saves in the background, without a toast.
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

const realAuthContextModule = await import('../../../../core/auth/auth-context');
mock.module('../../../../core/auth/auth-context', () => ({
    useAuth: () => ({ user: { id: OWNER, role: 'user' } }),
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
});

test('is Light with nothing stored or copied, and the saved theme once the settings hold one', async () => {
    const empty = await renderHook(() => useTheme(), client());
    expect(empty.latest.theme).toBe('light');
    await empty.unmount();

    const loaded = await renderHook(() => useTheme(), client({ theme: 'system' }));
    expect(loaded.latest.theme).toBe('system');
    await loaded.unmount();
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
