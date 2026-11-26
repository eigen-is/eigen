// The Server settings page has one Save for its three drafts: the organization's name, the default S3 storage and the
// server settings. It writes only the parts it is given, in that order, refreshes what each write changed and says
// "Settings saved" once. A refused write stops the ones after it and toasts only its error.
import { afterAll, beforeEach, expect, mock, test } from 'bun:test';
import type { S3Config } from '@workspace/lib/types/mount';
import { renderHook } from '../../../render-hook';
import { hasKey, installTransferHarness, toasts, trackingClient } from '../../../transfer-harness';

installTransferHarness();

const S3: S3Config = { endpoint: 'https://s3.test', bucket: 'b', prefix: '', accessKeyId: 'k', secretAccessKey: 's' };
const ok = (data: unknown) => ({ data, error: null, status: 200 });
const refused = { data: null, error: { status: 422, value: 'The bucket refused the keys' }, status: 422 };

// Each write the page sends, in order, and the one the server refuses.
const writes: string[] = [];
let refuse = '';
const reply = (write: string, data: unknown) => {
    writes.push(write);
    return write === refuse ? refused : ok(data);
};
const realApiModule = await import('../../../../core/api');
mock.module('../../../../core/api', () => ({
    ...realApiModule,
    settingsApi: {
        organization: { put: async ({ name }: { name: string }) => reply(`name ${name}`, { name }) },
        s3config: { put: async () => reply('s3', { ok: true }) },
        server: { put: async () => reply('settings', { notice: 'Keep these keys elsewhere' }) },
    },
}));
afterAll(() => {
    mock.module('../../../../core/api', () => realApiModule);
});

const { act } = await import('react');
const { adminKeys } = await import('../../../../core/admin/hooks/keys');
const { homeKeys } = await import('../../../../core/home/hooks/keys');
const { wasToasted } = await import('../../../../core/api-error');
const { publicKeys } = await import('../../../../core/public/hooks/keys');
const { s3ConfigKeys, settingsKeys } = await import('../../../../core/settings/hooks/keys');
const { useSaveServerSettingsPage } = await import('../../../../core/settings/hooks/use-save-server-settings-page');

beforeEach(() => {
    writes.length = 0;
    toasts.length = 0;
    refuse = '';
});

test('every changed part is written in order, refreshed, and the page says it saved once', async () => {
    const { queryClient, invalidated } = trackingClient();
    const { latest, unmount } = await renderHook(() => useSaveServerSettingsPage('org-1'), queryClient);
    let saved: unknown;
    await act(async () => {
        saved = await latest.mutateAsync({
            orgName: 'Acme Labs',
            s3Config: S3,
            settings: { mail: { senderName: 'A' } },
        });
    });
    await unmount();

    expect(writes).toEqual(['name Acme Labs', 's3', 'settings']);
    expect(toasts).toEqual(['success: Settings saved']);
    expect(saved).toEqual({ notice: 'Keep these keys elsewhere' });
    for (const key of [publicKeys.config, adminKeys.teams('org-1'), s3ConfigKeys.all, settingsKeys.server()]) {
        expect(hasKey(invalidated, key)).toBe(true);
    }
});

test('a part left out is not written', async () => {
    const { latest, unmount } = await renderHook(
        () => useSaveServerSettingsPage('org-1'),
        trackingClient().queryClient,
    );
    await act(async () => {
        await latest.mutateAsync({ orgName: 'Acme Labs' });
    });
    await unmount();

    expect(writes).toEqual(['name Acme Labs']);
    expect(toasts).toEqual(['success: Settings saved']);
});

test('a refused write stops the rest, toasts only its error, and what landed before it is refreshed', async () => {
    refuse = 's3';
    const { queryClient, invalidated } = trackingClient();
    const { latest, unmount } = await renderHook(() => useSaveServerSettingsPage('org-1'), queryClient);
    let failure: unknown = null;
    await act(async () => {
        await latest
            .mutateAsync({ orgName: 'Acme Labs', s3Config: S3, settings: { mail: { senderName: 'A' } } })
            .catch((error: unknown) => (failure = error));
    });
    await unmount();

    expect(writes).toEqual(['name Acme Labs', 's3']);
    expect(toasts).toEqual(['error: The bucket refused the keys']);
    expect(wasToasted(failure)).toBe(true);
    expect(hasKey(invalidated, publicKeys.config)).toBe(true);
    expect(hasKey(invalidated, settingsKeys.server())).toBe(false);
});

test('a rename refreshes the teams and users, and the next write waits for the public config refetch', async () => {
    const { queryClient, invalidated } = trackingClient();
    const refetch = Promise.withResolvers<void>();
    const track = queryClient.invalidateQueries.bind(queryClient);
    queryClient.invalidateQueries = ((filters?: { queryKey?: readonly unknown[] }) => {
        const result = track(filters as never);
        return hasKey([[...(filters?.queryKey ?? [])]], publicKeys.config) ? refetch.promise : result;
    }) as typeof queryClient.invalidateQueries;
    const { latest, unmount } = await renderHook(() => useSaveServerSettingsPage('org-1'), queryClient);
    let save: Promise<unknown> = Promise.resolve();
    await act(async () => {
        save = latest.mutateAsync({ orgName: 'Acme Labs', s3Config: S3 });
        await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(hasKey(invalidated, publicKeys.config)).toBe(true);
    expect(writes).toEqual(['name Acme Labs']);

    await act(async () => {
        refetch.resolve();
        await save;
    });
    await unmount();

    expect(writes).toEqual(['name Acme Labs', 's3']);
    expect(hasKey(invalidated, homeKeys.all)).toBe(true);
    expect(hasKey(invalidated, adminKeys.users())).toBe(true);
});
