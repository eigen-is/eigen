import { type QueryClient, useMutation, useQueryClient } from '@tanstack/react-query';
import { calendarApi, getCalendarImportUrl } from '@workspace/lib/api';
import { useAuth } from '@workspace/lib/auth';
import type { ImportEventsResult } from '@workspace/lib/types/calendar';
import { ICS_MIME } from '@workspace/lib/types/drive';
import { toast } from 'sonner';
import { AppError, onMutationError } from '../../api-error';
import { invalidateEventsImported } from './keys';

// One phrasing for both import paths: a file from the disk and a file from Drive report the same three
// counts. Nothing imported and nothing skipped means the file held no event this calendar could take —
// unreadable events say so, because the file did hold events and none of them landed.
function reportImport(queryClient: QueryClient, ownerId: string, result: ImportEventsResult): void {
    invalidateEventsImported(queryClient, ownerId);

    const { imported, skipped, failed } = result;
    if (!imported && !skipped) {
        if (failed) toast.error(`${failed} event${failed === 1 ? '' : 's'} could not be read`);
        else toast.error('No events found in this file');
        return;
    }
    const parts = [`Imported ${imported} event${imported === 1 ? '' : 's'}`];
    if (skipped) parts.push(`skipped ${skipped} duplicate${skipped === 1 ? '' : 's'}`);
    if (failed) parts.push(`${failed} unreadable`);
    toast.success(parts.join(', '));
}

// The file travels as the raw body, not multipart: the route reads one calendar stream, with the target
// calendar in the query string. Mirrors useImportMailFromUrl.
async function postImport(ownerId: string, calendarId: string, file: Blob): Promise<ImportEventsResult> {
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
        mutationFn: async ({ url, calendarId }: { url: string; calendarId: string }): Promise<ImportEventsResult> => {
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
        mutationFn: async (source: {
            calendarId: string;
            sourceOwnerId: string;
            sourceMountId: string;
            sourcePathId: string;
        }) => {
            const response = await calendarApi({ ownerId })['import-from-drive'].post(source);
            if (response.error) throw new AppError(response);
            return response.data;
        },
        onSuccess: (result) => reportImport(queryClient, ownerId, result),
        onError: onMutationError,
    });
}
