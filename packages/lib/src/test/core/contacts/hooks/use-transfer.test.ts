// What an import run tells the user. Every import path (a file from the disk, a file from Drive, the
// bytes behind a subject with no Drive path) reports its three counts through one copy, so the message is
// pinned here rather than in each caller.
import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test';
import type { ImportCountsResult } from '@workspace/lib/types/transfer';
import {
    fetchCalls,
    installTransferHarness,
    OWNER,
    renderHook,
    served,
    toasts,
    trackingClient,
} from '../../../transfer-harness';

installTransferHarness();

// The Eden client, stubbed to the one call the drive-import path makes.
let driveImportResult: ImportCountsResult = { imported: 0, skipped: 0, failed: 0 };
const realApiModule = await import('../../../../core/api');
mock.module('../../../../core/api', () => ({
    ...realApiModule,
    contactsApi: () => ({
        'import-from-drive': {
            post: async () => ({ data: driveImportResult, error: null, status: 200 }),
        },
    }),
}));

afterAll(() => {
    mock.module('../../../../core/api', () => realApiModule);
});

async function importFile(result: ImportCountsResult): Promise<string> {
    const { act } = await import('react');
    const { useImportContacts } = await import('../../../../core/contacts/hooks/use-transfer');
    served.importResponse = result;
    const { queryClient } = trackingClient();
    const { latest, unmount } = await renderHook(() => useImportContacts(), queryClient);

    await act(async () => {
        await latest.mutateAsync(new File(['BEGIN:VCARD\r\nEND:VCARD\r\n'], 'contacts.vcf'));
    });
    await act(() => unmount());
    return toasts.at(-1) ?? '';
}

describe('useImportContacts', () => {
    beforeEach(() => {
        toasts.length = 0;
    });

    test('a clean run reports the count it imported', async () => {
        expect(await importFile({ imported: 3, skipped: 0, failed: 0 })).toBe('success: Imported 3 contacts');
    });

    test('duplicates are named beside the import count, pluralized on their own count', async () => {
        expect(await importFile({ imported: 0, skipped: 3, failed: 0 })).toBe(
            'success: Imported 0 contacts, skipped 3 duplicates',
        );
    });

    test('one of each reads in the singular throughout', async () => {
        expect(await importFile({ imported: 1, skipped: 1, failed: 1 })).toBe(
            'success: Imported 1 contact, skipped 1 duplicate, 1 unreadable',
        );
    });

    test('a file that yielded nothing at all is an error, not a success with zeroes', async () => {
        expect(await importFile({ imported: 0, skipped: 0, failed: 0 })).toBe('error: No contacts found in this file');
    });

    test('a file whose every card was unreadable says so, not that it held no contacts', async () => {
        expect(await importFile({ imported: 0, skipped: 0, failed: 2 })).toBe('error: 2 contacts could not be read');
        expect(await importFile({ imported: 0, skipped: 0, failed: 1 })).toBe('error: 1 contact could not be read');
    });
});

describe('useImportContactsFile', () => {
    beforeEach(() => {
        toasts.length = 0;
        fetchCalls.length = 0;
    });

    test('a file picked from Drive reports through the same copy as a file picked from the disk', async () => {
        const { act } = await import('react');
        const { useImportContactsFile } = await import('../../../../core/contacts/hooks/use-transfer');
        driveImportResult = { imported: 1, skipped: 1, failed: 1 };
        const { queryClient } = trackingClient();
        const { latest, unmount } = await renderHook(() => useImportContactsFile(), queryClient);

        await act(async () => {
            await latest.mutateAsync({ drive: { sourceOwnerId: OWNER, sourceMountId: 'm1', sourcePathId: 'p1' } });
        });
        await act(() => unmount());

        expect(toasts.at(-1)).toBe('success: Imported 1 contact, skipped 1 duplicate, 1 unreadable');
    });

    test('a subject with no Drive path behind it posts the bytes it fetched', async () => {
        const { act } = await import('react');
        const { useImportContactsFile } = await import('../../../../core/contacts/hooks/use-transfer');
        served.importResponse = { imported: 2, skipped: 0, failed: 0 };
        const { queryClient } = trackingClient();
        const { latest, unmount } = await renderHook(() => useImportContactsFile(), queryClient);

        await act(async () => {
            await latest.mutateAsync({ url: '/mail/owner/message/m1/attachment/0' });
        });
        await act(() => unmount());

        expect(fetchCalls[0]!.url).toBe('/mail/owner/message/m1/attachment/0');
        expect(fetchCalls[1]!.body).toBeInstanceOf(Blob);
        expect(toasts.at(-1)).toBe('success: Imported 2 contacts');
    });
});
