import { type QueryClient, useMutation, useQueryClient } from '@tanstack/react-query';
import { getMailImportUrl, mailApi } from '@workspace/lib/api';
import { useAuth } from '@workspace/lib/auth';
import { MAILBOX_INBOX } from '@workspace/lib/constants/mailboxes';
import { EML_MIME } from '@workspace/lib/types/drive';
import type { ImportMailResult } from '@workspace/lib/types/mail';
import { toast } from 'sonner';
import { AppError, onMutationError } from '../../api-error';
import { invalidateMailboxes, invalidateMailReceived } from './keys';

// One landing place for both import paths: the message arrives unread in the inbox, so the open list and
// the unread counts both refresh — the SSE echo of the same delivery is not something a mutation can wait for.
function reportImport(queryClient: QueryClient, ownerId: string): void {
    invalidateMailReceived(queryClient, ownerId, MAILBOX_INBOX);
    invalidateMailboxes(queryClient, ownerId);
    toast.success('Imported to your inbox');
}

// The file travels as the raw body, not multipart: the route reads one message stream. Mirrors
// useImportContacts.
async function postImport(ownerId: string, file: Blob): Promise<ImportMailResult> {
    const response = await fetch(getMailImportUrl(ownerId), {
        method: 'POST',
        headers: { 'content-type': EML_MIME },
        body: file,
        credentials: 'include',
    });
    if (!response.ok) throw new Error(await response.text());
    return await response.json();
}

// A file with no Drive path behind it (a mail part, a chat attachment): the browser carries the bytes
// from the download URL to the import route.
export function useImportMailFromUrl() {
    const queryClient = useQueryClient();
    const { user } = useAuth();
    const ownerId = user?.id || '';

    return useMutation({
        mutationFn: async ({ url }: { url: string }): Promise<ImportMailResult> => {
            const response = await fetch(url, { credentials: 'include' });
            if (!response.ok) throw new Error(await response.text());
            return postImport(ownerId, await response.blob());
        },
        onSuccess: () => reportImport(queryClient, ownerId),
        onError: onMutationError,
    });
}

export function useImportMailFromDrive() {
    const queryClient = useQueryClient();
    const { user } = useAuth();
    const ownerId = user?.id || '';

    return useMutation({
        mutationFn: async (source: { sourceOwnerId: string; sourceMountId: string; sourcePathId: string }) => {
            const response = await mailApi({ ownerId })['import-from-drive'].post(source);
            if (response.error) throw new AppError(response);
            return response.data;
        },
        onSuccess: () => reportImport(queryClient, ownerId),
        onError: onMutationError,
    });
}
