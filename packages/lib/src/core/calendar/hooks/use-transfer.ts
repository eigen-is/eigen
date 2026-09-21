import { useMutation, useQueryClient } from '@tanstack/react-query';
import { calendarApi, getCalendarExportUrl, getCalendarImportUrl } from '@workspace/lib/api';
import { ICS_MIME } from '@workspace/lib/types/drive';
import type { FileImportSource } from '@workspace/lib/types/file-subject';
import type { ImportCountsResult } from '@workspace/lib/types/transfer';
import { useCallback } from 'react';
import { AppError, onMutationError } from '../../api-error';
import { useFileDownload } from '../../download';
import { fetchImportBlob, postImportBytes, reportImportCounts } from '../../transfer';
import { invalidateEventList } from './keys';

// The export answers with the file itself, so it goes through raw fetch rather than Eden — same download
// hook as useExportContacts, down to reporting its own failures (there is no mutation to carry them).
// The home is named per call, not per hook: a sidebar draws its own calendars and a team's side by side.
export function useExportCalendar() {
    const { download, isDownloading } = useFileDownload();

    const exportCalendar = useCallback(
        (ownerId: string, calendarId: string, ids?: string[]) =>
            download(getCalendarExportUrl(ownerId), 'calendar.ics', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify(ids ? { calendarId, ids } : { calendarId }),
            }),
        [download],
    );

    return { exportCalendar, isExporting: isDownloading };
}

// One import, whichever identity the file has: a Drive path the server copies out, or the download URL a
// file with no Drive path behind it (a mail part, a chat attachment) is read from in the browser. Unlike
// its siblings this one needs a target, so the picker's chosen home and calendar ride with the source.
export function useImportCalendar() {
    const queryClient = useQueryClient();

    return useMutation({
        mutationFn: async (
            source: FileImportSource & { ownerId: string; calendarId: string },
        ): Promise<ImportCountsResult> => {
            const { ownerId, calendarId } = source;
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
        onSuccess: (result, { ownerId }) => {
            invalidateEventList(queryClient, ownerId);
            reportImportCounts(result, 'event');
        },
        onError: onMutationError,
    });
}
