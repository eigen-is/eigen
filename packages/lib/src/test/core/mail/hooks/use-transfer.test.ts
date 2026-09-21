// What an .eml import tells the user, and which caches it revives. One mutation takes both identities (a
// Drive path the server copies, bytes the browser fetched) and lands one message in the inbox, so the
// copy, the invalidation and the metered bytes are pinned here rather than in each caller.
import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test';
import type { ImportMailResult } from '@workspace/lib/types/mail';
import { emailKeys, mailboxKeys } from '../../../../core/mail/hooks/keys';
import {
    fetchCalls,
    hasKey,
    installTransferHarness,
    OWNER,
    renderHook,
    served,
    toasts,
    trackingClient,
} from '../../../transfer-harness';

installTransferHarness();

// The Eden client, stubbed to the one call the drive-import path makes.
const driveImportResult: ImportMailResult = { id: 'imported-1' };
const realApiModule = await import('../../../../core/api');
mock.module('../../../../core/api', () => ({
    ...realApiModule,
    mailApi: () => ({
        'import-from-drive': {
            post: async () => ({ data: driveImportResult, error: null, status: 200 }),
        },
    }),
}));

afterAll(() => {
    mock.module('../../../../core/api', () => realApiModule);
});

describe('useImportMail', () => {
    beforeEach(() => {
        toasts.length = 0;
        fetchCalls.length = 0;
        served.importResponse = { id: 'imported-2' };
    });

    test('a file picked from Drive lands in the inbox and refreshes the list and the counts', async () => {
        const { act } = await import('react');
        const { useImportMail } = await import('../../../../core/mail/hooks/use-transfer');
        const { queryClient, invalidated } = trackingClient();
        const { latest, unmount } = await renderHook(() => useImportMail(), queryClient);

        await act(async () => {
            await latest.mutateAsync({ drive: { sourceOwnerId: OWNER, sourceMountId: 'm1', sourcePathId: 'p1' } });
        });
        await act(() => unmount());

        expect(toasts.at(-1)).toBe('success: Imported to your inbox');
        expect(hasKey(invalidated, emailKeys.list(OWNER, ''))).toBe(true);
        expect(hasKey(invalidated, mailboxKeys.lists(OWNER))).toBe(true);
    });

    test('a part with no Drive path behind it posts the bytes it fetched', async () => {
        const { act } = await import('react');
        const { useImportMail } = await import('../../../../core/mail/hooks/use-transfer');
        const { queryClient, invalidated } = trackingClient();
        const { latest, unmount } = await renderHook(() => useImportMail(), queryClient);

        await act(async () => {
            await latest.mutateAsync({ url: '/mail/owner/message/m1/attachment/0' });
        });
        await act(() => unmount());

        expect(fetchCalls[0]!.url).toBe('/mail/owner/message/m1/attachment/0');
        expect(fetchCalls[1]!.body).toBeInstanceOf(Blob);
        expect(toasts.at(-1)).toBe('success: Imported to your inbox');
        expect(hasKey(invalidated, emailKeys.list(OWNER, ''))).toBe(true);
    });
});
