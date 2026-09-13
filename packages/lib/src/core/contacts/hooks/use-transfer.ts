import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { contactsApi, getContactsExportUrl, getContactsImportUrl, getDriveDownloadUrl } from '@workspace/lib/api';
import { useAuth } from '@workspace/lib/auth';
import { IMPORT_MAX_BYTES, IMPORT_MAX_CARDS } from '@workspace/lib/constants/contact';
import type { ContactTransferSource, ImportContactsResult, ParsedCard } from '@workspace/lib/types/contact';
import { parseVCard, splitVCards, transcodeTo30 } from '@workspace/lib/vcard';
import { useCallback, useState } from 'react';
import { toast } from 'sonner';
import { AppError, onMutationError } from '../../api-error';
import { downloadBlob, filenameFromDisposition } from '../../download';
import { contactKeys, invalidateContactCreated } from './keys';

// One phrasing for both import paths: a file from the disk and a file from Drive report the same three
// counts. Nothing imported and nothing skipped means the file held no contact this book could take.
function reportImport(result: ImportContactsResult): void {
    const { imported, skipped, failed } = result;
    if (!imported && !skipped) {
        toast.error('No contacts found in this file');
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
                headers: { 'content-type': 'text/vcard' },
                body: file,
                credentials: 'include',
            });
            if (!response.ok) throw new Error(await response.text());
            return await response.json();
        },
        onSuccess: (result) => {
            invalidateContactCreated(queryClient, ownerId);
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
            invalidateContactCreated(queryClient, ownerId);
            reportImport(result);
        },
        onError: onMutationError,
    });
}

// The cards in a Drive file, read for preview only — nothing is imported. The file is fetched whole, so
// the query stays off anything over the import ceiling; `updatedAt` in the key makes a new version a new
// entry, which is why it never goes stale. It parses no more cards than an import would accept, and
// reports `total` so the preview can say how many the file holds.
export function useVCardFile(ownerId: string, mountId: string, pathId: string, updatedAt: Date, size: number) {
    return useQuery({
        queryKey: contactKeys.vcardFile(ownerId, mountId, pathId, updatedAt.getTime()),
        queryFn: async (): Promise<{ cards: ParsedCard[]; dropped: number; total: number }> => {
            const response = await fetch(getDriveDownloadUrl(ownerId, mountId, pathId, updatedAt), {
                credentials: 'include',
            });
            if (!response.ok) throw new Error(await response.text());
            const texts = splitVCards(await response.text());
            const cards: ParsedCard[] = [];
            let dropped = 0;
            for (const text of texts.slice(0, IMPORT_MAX_CARDS)) {
                // One card the parser refuses never costs the preview the rest of the file.
                try {
                    cards.push(parseVCard(transcodeTo30(text)));
                } catch {
                    dropped++;
                }
            }
            return { cards, dropped, total: texts.length };
        },
        enabled: !!ownerId && !!mountId && !!pathId && size <= IMPORT_MAX_BYTES,
        staleTime: Infinity,
    });
}
