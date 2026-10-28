// A reader's text width on a page-less doc: Narrow until they choose, what they chose read back from their settings
// or, before those load, from this browser's copy, and a choice saved to their settings at once.
import { afterAll, describe, expect, mock, test } from 'bun:test';
import { QueryClient } from '@tanstack/react-query';
import type { UserSettings } from '@workspace/lib/types/settings';
import { docsTextWidth } from '@workspace/lib/types/settings';
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
// The server's settings: a save merges into them, as the route does, and a read returns them.
const saved: UserSettings[] = [];
let stored: UserSettings = {};
mock.module('../../../../core/api', () => ({
    ...realApiModule,
    spaceApi: () => ({
        settings: {
            get: async () => ({ data: stored, error: null, status: 200 }),
            put: async (body: UserSettings) => {
                saved.push(body);
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

const { useDocsTextWidth } = await import('../../../../core/docs/hooks/use-docs-text-width');
const { act } = await import('react');

function client(settings?: UserSettings): QueryClient {
    const queryClient = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
    if (settings) queryClient.setQueryData(spaceKeys.settings(OWNER), settings);
    return queryClient;
}

describe('docsTextWidth', () => {
    test('is Narrow for settings that never chose one, or chose one this build does not know', () => {
        expect(docsTextWidth(undefined)).toBe('narrow');
        expect(docsTextWidth({})).toBe('narrow');
        expect(docsTextWidth({ docsView: {} })).toBe('narrow');
        expect(docsTextWidth(JSON.parse('{"docsView":{"textWidth":"huge"}}'))).toBe('narrow');
        expect(docsTextWidth({ docsView: { textWidth: 'full' } })).toBe('full');
    });
});

describe('useDocsTextWidth', () => {
    test('reads the stored choice and writes a new one to the settings, cached for the next open', async () => {
        window.localStorage.clear();
        stored = { docsView: { textWidth: 'medium' } };
        const queryClient = client(stored);
        const first = await renderHook(() => useDocsTextWidth(), queryClient);
        expect(first.latest.textWidth).toBe('medium');
        await act(async () => {
            first.latest.setTextWidth('wide');
        });
        expect(saved).toEqual([{ docsView: { textWidth: 'wide' } }]);
        expect(docsTextWidth(queryClient.getQueryData(spaceKeys.settings(OWNER)))).toBe('wide');
        await first.unmount();

        // Before the settings load, the browser's copy of the last choice draws the column.
        stored = {};
        const reopened = await renderHook(() => useDocsTextWidth(), client());
        expect(reopened.latest.textWidth).toBe('wide');
        await reopened.unmount();
    });

    test("the loaded settings replace this browser's copy, so another device's choice draws first on the next open", async () => {
        window.localStorage.clear();
        stored = {};
        const before = await renderHook(() => useDocsTextWidth(), client());
        await act(async () => {
            before.latest.setTextWidth('wide');
        });
        await before.unmount();

        // Chosen on another device meanwhile.
        stored = { docsView: { textWidth: 'medium' } };
        const loaded = await renderHook(() => useDocsTextWidth(), client(stored));
        expect(loaded.latest.textWidth).toBe('medium');
        await loaded.unmount();
        const reopened = await renderHook(() => useDocsTextWidth(), client());
        expect(reopened.latest.textWidth).toBe('medium');
        await reopened.unmount();
    });

    test('is Narrow with nothing stored or cached', async () => {
        window.localStorage.clear();
        stored = {};
        const { latest, unmount } = await renderHook(() => useDocsTextWidth(), client());
        expect(latest.textWidth).toBe('narrow');
        await unmount();
    });
});
