import { useMutation, useQueryClient } from '@tanstack/react-query';
import { contactsApi, getContactsExportUrl, getContactsImportUrl } from '@workspace/lib/api';
import { useAuth } from '@workspace/lib/auth';
import type { ContactTransferSource, ImportContactsResult } from '@workspace/lib/types/contact';
import { VCARD_MIMES } from '@workspace/lib/types/drive';
import { useCallback, useState } from 'react';
import { toast } from 'sonner';
import { AppError, onMutationError } from '../../api-error';
import { downloadBlob, filenameFromDisposition } from '../../download';
import { invalidateContactList } from './keys';

// One phrasing for both import paths: a file from the disk and a file from Drive report the same three
// counts. Nothing imported and nothing skipped means the file held no contact this book could take —
// unreadable cards say so, because the file did hold contacts and none of them landed.
function reportImport(result: ImportContactsResult): void {
    const { imported, skipped, failed } = result;
    if (!imported && !skipped) {
        if (failed) toast.error(`${failed} contact${failed === 1 ? '' : 's'} could not be read`);
        else toast.error('No contacts found in this file');
        return;
    }
    const parts = [`Imported ${imported} contact${imported === 1 ? '' : 's'}`];
    if (skipped) parts.push(`skipped ${skipped} duplicate${skipped === 1 ? '' : 's'}`);
    if (failed) parts.push(`${failed} unreadable`);
    toast.success(parts.join(', '));
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

export function useImportContacts() {
    const queryClient = useQueryClient();
    const { user } = useAuth();
    const ownerId = user?.id || '';

    return useMutation({
        // The file travels as the raw body, not multipart: the route reads one vCard stream. Mirrors
        // useImportDocument.
        mutationFn: async (file: File): Promise<ImportContactsResult> => {
            const response = await fetch(getContactsImportUrl(ownerId), {
                method: 'POST',
                headers: { 'content-type': VCARD_MIMES[0] },
                body: file,
                credentials: 'include',
            });
            if (!response.ok) throw new Error(await response.text());
            return await response.json();
        },
        onSuccess: (result) => {
            invalidateContactList(queryClient, ownerId);
            reportImport(result);
        },
        onError: onMutationError,
    });
}

export function useImportContactsFromDrive() {
    const queryClient = useQueryClient();
    const { user } = useAuth();
    const ownerId = user?.id || '';

    return useMutation({
        mutationFn: async (source: ContactTransferSource) => {
            const response = await contactsApi({ ownerId })['import-from-drive'].post(source);
            if (response.error) throw new AppError(response);
            return response.data;
        },
        onSuccess: (result) => {
            invalidateContactList(queryClient, ownerId);
            reportImport(result);
        },
        onError: onMutationError,
    });
}
