import { type QueryClient, useMutation, useQueryClient } from '@tanstack/react-query';
import { contactsApi, getContactsExportUrl, getContactsImportUrl } from '@workspace/lib/api';
import { useAuth } from '@workspace/lib/auth';
import { type DriveImportSource, VCARD_MIMES } from '@workspace/lib/types/drive';
import type { ImportCountsResult } from '@workspace/lib/types/transfer';
import { useCallback, useState } from 'react';
import { AppError, onMutationError } from '../../api-error';
import { downloadBlob, filenameFromDisposition } from '../../download';
import { reportImportCounts } from '../../transfer';
import { invalidateContactList } from './keys';

// One landing place for every import path: the cards are in the book, so the open list refreshes, and
// the counts are reported in the wording every counted import shares.
function reportImport(queryClient: QueryClient, ownerId: string, result: ImportCountsResult): void {
    invalidateContactList(queryClient, ownerId);
    reportImportCounts(result, 'contact');
}

// The export answers with the file itself, so it goes through raw fetch rather than Eden — same shape as
// useExportDocument, down to reporting its own failures (there is no mutation to carry them).
export function useExportContacts() {
    const { user } = useAuth();
    const ownerId = user?.id || '';
    const [isExporting, setIsExporting] = useState(false);

    const exportContacts = useCallback(
        async (ids?: string[]) => {
            setIsExporting(true);
            try {
                const response = await fetch(getContactsExportUrl(ownerId), {
                    method: 'POST',
                    headers: { 'content-type': 'application/json' },
                    body: JSON.stringify(ids ? { ids } : {}),
                    credentials: 'include',
                });
                if (!response.ok) {
                    const text = await response.text();
                    throw new Error(text || `Export failed (${response.status})`);
                }
                const blob = await response.blob();
                const name = filenameFromDisposition(response.headers.get('Content-Disposition'), 'contacts.vcf');
                downloadBlob(blob, name);
            } catch (e) {
                onMutationError(e);
            } finally {
                setIsExporting(false);
            }
        },
        [ownerId],
    );

    return { exportContacts, isExporting };
}

// The file travels as the raw body, not multipart: the route reads one vCard stream. Mirrors
// useImportDocument.
async function postImport(ownerId: string, file: Blob): Promise<ImportCountsResult> {
    const response = await fetch(getContactsImportUrl(ownerId), {
        method: 'POST',
        headers: { 'content-type': VCARD_MIMES[0] },
        body: file,
        credentials: 'include',
    });
    if (!response.ok) throw new Error(await response.text());
    return await response.json();
}

export function useImportContacts() {
    const queryClient = useQueryClient();
    const { user } = useAuth();
    const ownerId = user?.id || '';

    return useMutation({
        mutationFn: (file: File): Promise<ImportCountsResult> => postImport(ownerId, file),
        onSuccess: (result) => reportImport(queryClient, ownerId, result),
        onError: onMutationError,
    });
}

// A file with no Drive path behind it (a mail part, a chat attachment): a vCard is kilobytes, so the
// browser carries the bytes from the download URL to the import route.
export function useImportContactsFromUrl() {
    const queryClient = useQueryClient();
    const { user } = useAuth();
    const ownerId = user?.id || '';

    return useMutation({
        mutationFn: async ({ url }: { url: string }): Promise<ImportCountsResult> => {
            const response = await fetch(url, { credentials: 'include' });
            if (!response.ok) throw new Error(await response.text());
            return postImport(ownerId, await response.blob());
        },
        onSuccess: (result) => reportImport(queryClient, ownerId, result),
        onError: onMutationError,
    });
}

export function useImportContactsFromDrive() {
    const queryClient = useQueryClient();
    const { user } = useAuth();
    const ownerId = user?.id || '';

    return useMutation({
        mutationFn: async (source: DriveImportSource) => {
            const response = await contactsApi({ ownerId })['import-from-drive'].post(source);
            if (response.error) throw new AppError(response);
            return response.data;
        },
        onSuccess: (result) => reportImport(queryClient, ownerId, result),
        onError: onMutationError,
    });
}
