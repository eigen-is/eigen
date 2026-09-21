import { useMutation, useQueryClient } from '@tanstack/react-query';
import { getMailImportUrl, mailApi } from '@workspace/lib/api';
import { useAuth } from '@workspace/lib/auth';
import { EML_MIME } from '@workspace/lib/types/drive';
import type { FileImportSource } from '@workspace/lib/types/file-subject';
import type { ImportMailResult } from '@workspace/lib/types/mail';
import { toast } from 'sonner';
import { AppError, onMutationError } from '../../api-error';
import { fetchImportBlob, postImportBytes } from '../../transfer';
import { invalidateMailImported } from './keys';

// One import, whichever identity the file has: a Drive path the server copies out, or the download URL a
// file with no Drive path behind it (a mail part, a chat attachment) is read from in the browser.
export function useImportMail() {
    const queryClient = useQueryClient();
    const { user } = useAuth();
    const ownerId = user?.id || '';

    return useMutation({
        mutationFn: async (source: FileImportSource): Promise<ImportMailResult> => {
            if (source.url !== undefined)
                return postImportBytes(getMailImportUrl(ownerId), EML_MIME, await fetchImportBlob(source.url));
            const response = await mailApi({ ownerId })['import-from-drive'].post(source.drive);
            if (response.error) throw new AppError(response);
            return response.data;
        },
        onSuccess: () => {
            invalidateMailImported(queryClient, ownerId);
            toast.success('Imported to your inbox');
        },
        onError: onMutationError,
    });
}
