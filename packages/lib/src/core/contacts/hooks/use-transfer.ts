import { type QueryClient, useMutation, useQueryClient } from '@tanstack/react-query';
import { contactsApi, getContactsExportUrl, getContactsImportUrl } from '@workspace/lib/api';
import { useAuth } from '@workspace/lib/auth';
import { VCARD_MIMES } from '@workspace/lib/types/drive';
import type { FileImportSource } from '@workspace/lib/types/file-subject';
import type { ImportCountsResult } from '@workspace/lib/types/transfer';
import { useCallback } from 'react';
import { AppError, onMutationError } from '../../api-error';
import { useFileDownload } from '../../download';
import { fetchImportBlob, postImportBytes, reportImportCounts } from '../../transfer';
import { invalidateContactList } from './keys';

// The export answers with the file itself, so it goes through raw fetch rather than Eden — same download
// hook as useExportDocument, down to reporting its own failures (there is no mutation to carry them).
export function useExportContacts() {
    const { user } = useAuth();
    const ownerId = user?.id || '';
    const { download, isDownloading } = useFileDownload();

    const exportContacts = useCallback(
        (ids?: string[]) =>
            download(getContactsExportUrl(ownerId), 'contacts.vcf', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify(ids ? { ids } : {}),
            }),
        [download, ownerId],
    );

    return { exportContacts, isExporting: isDownloading };
}

// One landing place for every import path: the cards are in the book, so the open list refreshes, and the
// counts are reported in the wording every counted import shares.
function reportImport(queryClient: QueryClient, ownerId: string, result: ImportCountsResult): void {
    invalidateContactList(queryClient, ownerId);
    reportImportCounts(result, 'contact');
}

// The file the user picked off their own disk, posted as the raw body the route reads as one vCard stream.
export function useImportContacts() {
    const queryClient = useQueryClient();
    const { user } = useAuth();
    const ownerId = user?.id || '';

    return useMutation({
        mutationFn: (file: File): Promise<ImportCountsResult> =>
            postImportBytes(getContactsImportUrl(ownerId), VCARD_MIMES[0], file),
        onSuccess: (result) => reportImport(queryClient, ownerId, result),
        onError: onMutationError,
    });
}

// One import, whichever identity the file has: a Drive path the server copies out, or the download URL a
// file with no Drive path behind it (a mail part, a chat attachment) is read from in the browser.
export function useImportContactsFile() {
    const queryClient = useQueryClient();
    const { user } = useAuth();
    const ownerId = user?.id || '';

    return useMutation({
        mutationFn: async (source: FileImportSource): Promise<ImportCountsResult> => {
            if (source.url !== undefined)
                return postImportBytes(
                    getContactsImportUrl(ownerId),
                    VCARD_MIMES[0],
                    await fetchImportBlob(source.url),
                );
            const response = await contactsApi({ ownerId })['import-from-drive'].post(source.drive);
            if (response.error) throw new AppError(response);
            return response.data;
        },
        onSuccess: (result) => reportImport(queryClient, ownerId, result),
        onError: onMutationError,
    });
}
