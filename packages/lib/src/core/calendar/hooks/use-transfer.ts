import { useMutation, useQueryClient } from '@tanstack/react-query';
import { calendarApi, getCalendarImportUrl } from '@workspace/lib/api';
import { useAuth } from '@workspace/lib/auth';
import { ICS_MIME } from '@workspace/lib/types/drive';
import type { FileImportSource } from '@workspace/lib/types/file-subject';
import type { ImportCountsResult } from '@workspace/lib/types/transfer';
import { AppError, onMutationError } from '../../api-error';
import { fetchImportBlob, postImportBytes, reportImportCounts } from '../../transfer';
import { invalidateEventsImported } from './keys';

// One import, whichever identity the file has: a Drive path the server copies out, or the download URL a
// file with no Drive path behind it (a mail part, a chat attachment) is read from in the browser. Unlike
// its siblings this one needs a target, so the picker's chosen calendar rides with the source.
export function useImportCalendar() {
    const queryClient = useQueryClient();
    const { user } = useAuth();
    const ownerId = user?.id || '';

    return useMutation({
        mutationFn: async (source: FileImportSource & { calendarId: string }): Promise<ImportCountsResult> => {
            const { calendarId } = source;
            if (source.url !== undefined)
                return postImportBytes(
                    getCalendarImportUrl(ownerId, calendarId),
                    ICS_MIME,
                    await fetchImportBlob(source.url),
                );
            const response = await calendarApi({ ownerId })['import-from-drive'].post({
                calendarId,
                ...source.drive,
            });
            if (response.error) throw new AppError(response);
            return response.data;
        },
        onSuccess: (result) => {
            invalidateEventsImported(queryClient, ownerId);
            reportImportCounts(result, 'event');
        },
        onError: onMutationError,
    });
}
