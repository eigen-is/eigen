// The one read of the server's hosted-mail flag. Every Mail entry point hangs off it, so what it
// reports before the config lands — on — is pinned here.
import { describe, expect, test } from 'bun:test';
import { QueryClient } from '@tanstack/react-query';
import { publicKeys } from '../../../../core/public/hooks/keys';
import { useEnabledApps, useHomeDataLabel, useMailEnabled } from '../../../../core/public/hooks/use-public';
import { installHappyDom } from '../../../happy-dom';
import { renderHook } from '../../../render-hook';

installHappyDom();

describe('useMailEnabled', () => {
    test('reports mail on until the server config lands', async () => {
        const { latest, unmount } = await renderHook(() => useMailEnabled(), new QueryClient());
        expect(latest).toBe(true);
        await unmount();
    });

    test('follows the mailEnabled flag the server reports', async () => {
        for (const mailEnabled of [true, false]) {
            const queryClient = new QueryClient();
            queryClient.setQueryData(publicKeys.config, { mailEnabled });
            const { latest, unmount } = await renderHook(() => useMailEnabled(), queryClient);
            expect(latest).toBe(mailEnabled);
            await unmount();
        }
    });
});

describe('useHomeDataLabel', () => {
    test('names Mail only on a server that hosts it', async () => {
        for (const [mailEnabled, label] of [
            [true, 'Mail, Contacts & Calendar'],
            [false, 'Contacts & Calendar'],
        ] as const) {
            const queryClient = new QueryClient();
            queryClient.setQueryData(publicKeys.config, { mailEnabled });
            const { latest, unmount } = await renderHook(() => useHomeDataLabel(), queryClient);
            expect(latest).toBe(label);
            await unmount();
        }
    });
});

describe('useEnabledApps', () => {
    test('offers Mail only on a server that hosts it', async () => {
        for (const mailEnabled of [true, false]) {
            const queryClient = new QueryClient();
            queryClient.setQueryData(publicKeys.config, { mailEnabled });
            const { latest, unmount } = await renderHook(() => useEnabledApps(), queryClient);
            const names = latest.map((app) => app.name);
            expect(names.includes('Mail')).toBe(mailEnabled);
            expect(names).toContain('Drive');
            await unmount();
        }
    });
});
