// A personal setting that saves on its own, such as a switch, shows its result where it was changed, so its save says
// nothing. The signature's Save leaves the editor looking as it did, so that one says "Signature saved".
import { afterAll, beforeEach, expect, mock, test } from 'bun:test';
import type { UserSettings } from '@workspace/lib/types/settings';
import { renderHook } from '../../../render-hook';
import { hasKey, installTransferHarness, OWNER, toasts, trackingClient } from '../../../transfer-harness';

installTransferHarness();

const saved: UserSettings[] = [];
const realApiModule = await import('../../../../core/api');
mock.module('../../../../core/api', () => ({
    ...realApiModule,
    spaceApi: () => ({
        settings: {
            put: async (body: UserSettings) => {
                saved.push(body);
                return { data: body, error: null, status: 200 };
            },
        },
    }),
}));
afterAll(() => {
    mock.module('../../../../core/api', () => realApiModule);
});

const { act } = await import('react');
const { spaceKeys } = await import('../../../../core/space/hooks/keys');
const { useSaveSignature, useUpdateSpaceSettings } = await import('../../../../core/space/hooks/use-space-settings');

beforeEach(() => {
    saved.length = 0;
    toasts.length = 0;
});

test('a setting saved on its own reloads the settings without a toast', async () => {
    const { queryClient, invalidated } = trackingClient();
    const { latest, unmount } = await renderHook(() => useUpdateSpaceSettings(), queryClient);
    await act(async () => {
        await latest.mutateAsync({ celebrations: false });
    });
    await unmount();

    expect(saved).toEqual([{ celebrations: false }]);
    expect(toasts).toEqual([]);
    expect(hasKey(invalidated, spaceKeys.settings(OWNER))).toBe(true);
});

test('a saved signature becomes the only one, and the save says so', async () => {
    const { queryClient, invalidated } = trackingClient();
    const { latest, unmount } = await renderHook(() => useSaveSignature(), queryClient);
    const signature = { id: 's1', name: 'Default', html: '<p>Ada</p>' };
    await act(async () => {
        await latest.mutateAsync(signature);
    });
    await unmount();

    expect(saved).toEqual([{ email: { signatures: [signature] } }]);
    expect(toasts).toEqual(['success: Signature saved']);
    expect(hasKey(invalidated, spaceKeys.settings(OWNER))).toBe(true);
});
