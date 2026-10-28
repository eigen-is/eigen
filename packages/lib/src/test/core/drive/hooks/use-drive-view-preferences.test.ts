import { afterAll, expect, mock, test } from 'bun:test';
import { QueryClient } from '@tanstack/react-query';
import type { UserSettings } from '@workspace/lib/types/settings';
import { spaceKeys } from '../../../../core/space/hooks/keys';
import { installHappyDom } from '../../../happy-dom';
import { renderHook } from '../../../render-hook';

installHappyDom();

const OWNER = 'u'.repeat(32);

const realAuthContextModule = await import('../../../../core/auth/auth-context');
mock.module('../../../../core/auth/auth-context', () => ({
    useAuth: () => ({ user: { id: OWNER, role: 'user' } }),
}));

const realApiModule = await import('../../../../core/api');
let stored: UserSettings = {};
mock.module('../../../../core/api', () => ({
    ...realApiModule,
    spaceApi: () => ({
        settings: {
            get: async () => ({ data: stored, error: null, status: 200 }),
            put: async (body: UserSettings) => {
                stored = { ...stored, ...body };
                return { data: stored, error: null, status: 200 };
            },
        },
    }),
}));

afterAll(() => {
    mock.module('../../../../core/api', () => realApiModule);
    mock.module('../../../../core/auth/auth-context', () => realAuthContextModule);
});

const { useDriveViewPreferences } = await import('../../../../core/drive/hooks/use-drive-view-preferences');

function client(settings?: UserSettings): QueryClient {
    const queryClient = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
    if (settings) queryClient.setQueryData(spaceKeys.settings(OWNER), settings);
    return queryClient;
}

test("the loaded settings replace this browser's copy, so another device's view draws first on the next open", async () => {
    window.localStorage.clear();
    stored = { driveView: { mode: 'grid', sortKey: 'size', sortDir: 'desc' } };
    const loaded = await renderHook(() => useDriveViewPreferences(), client(stored));
    expect(loaded.latest.mode).toBe('grid');
    await loaded.unmount();

    // Opened again before the settings load.
    const reopened = await renderHook(() => useDriveViewPreferences(), client());
    expect([reopened.latest.mode, reopened.latest.sortKey, reopened.latest.sortDir]).toEqual(['grid', 'size', 'desc']);
    await reopened.unmount();
});
