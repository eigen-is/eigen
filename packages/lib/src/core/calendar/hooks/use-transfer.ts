import { type QueryClient, useMutation, useQueryClient } from '@tanstack/react-query';
import { calendarApi, getCalendarImportUrl } from '@workspace/lib/api';
import { useAuth } from '@workspace/lib/auth';
import { type DriveImportSource, ICS_MIME } from '@workspace/lib/types/drive';
import type { ImportCountsResult } from '@workspace/lib/types/transfer';
import { AppError, onMutationError } from '../../api-error';
import { reportImportCounts } from '../../transfer';
import { invalidateEventsImported } from './keys';

// One landing place for every import path: the events are in the calendar, so the open views refresh,
// and the counts are reported in the wording every counted import shares.
function reportImport(queryClient: QueryClient, ownerId: string, result: ImportCountsResult): void {
    invalidateEventsImported(queryClient, ownerId);
    reportImportCounts(result, 'event');
}

// The file travels as the raw body, not multipart: the route reads one calendar stream, with the target
// calendar in the query string. Mirrors useImportMailFromUrl.
async function postImport(ownerId: string, calendarId: string, file: Blob): Promise<ImportCountsResult> {
    const response = await fetch(getCalendarImportUrl(ownerId, calendarId), {
        method: 'POST',
        headers: { 'content-type': ICS_MIME },
        body: file,
        credentials: 'include',
    });
    if (!response.ok) throw new Error(await response.text());
    return await response.json();
}

// A file with no Drive path behind it (a mail part, a chat attachment): the browser carries the bytes
// from the download URL to the import route.
export function useImportCalendarFromUrl() {
    const queryClient = useQueryClient();
    const { user } = useAuth();
    const ownerId = user?.id || '';

    return useMutation({
        mutationFn: async ({ url, calendarId }: { url: string; calendarId: string }): Promise<ImportCountsResult> => {
            const response = await fetch(url, { credentials: 'include' });
            if (!response.ok) throw new Error(await response.text());
            return postImport(ownerId, calendarId, await response.blob());
        },
        onSuccess: (result) => reportImport(queryClient, ownerId, result),
        onError: onMutationError,
    });
}

export function useImportCalendarFromDrive() {
    const queryClient = useQueryClient();
    const { user } = useAuth();
    const ownerId = user?.id || '';

    return useMutation({
        mutationFn: async (source: DriveImportSource & { calendarId: string }) => {
            const response = await calendarApi({ ownerId })['import-from-drive'].post(source);
            if (response.error) throw new AppError(response);
            return response.data;
        },
        onSuccess: (result) => reportImport(queryClient, ownerId, result),
        onError: onMutationError,
    });
}
