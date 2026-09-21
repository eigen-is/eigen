import { useMutation, useQueryClient } from '@tanstack/react-query';
import { calendarApi, getCalendarExportUrl, getCalendarImportUrl } from '@workspace/lib/api';
import { parseOwnerId } from '@workspace/lib/types';
import { ICS_MIME } from '@workspace/lib/types/drive';
import type { FileImportSource } from '@workspace/lib/types/file-subject';
import type { ImportCountsResult } from '@workspace/lib/types/transfer';
import { useCallback, useRef } from 'react';
import { AppError, onMutationError } from '../../api-error';
import { useFileDownload } from '../../download';
import { fetchImportBlob, postImportBytes, reportImportCounts } from '../../transfer';
import { invalidateEventList } from './keys';
import { useCreateCalendar, useDeleteCalendar } from './use-calendar';

// The homes a whole `.ics` may leave or enter: the viewer's own and a team's, the only two the transfer
// routes resolve. A calendar shared out of another user's home is refused there, so it is neither an
// export source nor an import target.
export function isTransferableCalendarHome(ownerId: string, viewerId: string): boolean {
    return ownerId === viewerId || parseOwnerId(ownerId).type === 'team';
}

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

// Where a picked file lands: a calendar that exists, in whichever home holds it, or one made in the
// viewer's own home for this file alone.
export type ImportCalendarTarget =
    | { kind: 'existing'; ownerId: string; calendarId: string }
    | { kind: 'new'; name: string; color: string };

// The whole action an `.ics` picker runs. A new calendar is made before the import and, when nothing
// landed in it, deleted again — the user asked for the file's events, never for an empty calendar. The
// one a failed attempt made is remembered, so a retry imports into it rather than making a second of the
// same name; `forgetNewCalendar` drops that memory when the dialog closes.
export function useImportToCalendar(ownerId: string): {
    importToCalendar: (source: FileImportSource, target: ImportCalendarTarget) => Promise<void>;
    forgetNewCalendar: () => void;
} {
    const createCalendar = useCreateCalendar(ownerId);
    const deleteCalendar = useDeleteCalendar(ownerId);
    const importCalendar = useImportCalendar();
    const createdCalendarId = useRef<string | null>(null);

    const importToCalendar = useCallback(
        async (source: FileImportSource, target: ImportCalendarTarget) => {
            if (target.kind === 'existing') {
                await importCalendar.mutateAsync({ ...source, ownerId: target.ownerId, calendarId: target.calendarId });
                return;
            }
            if (!createdCalendarId.current) {
                const created = await createCalendar.mutateAsync({ name: target.name, color: target.color });
                createdCalendarId.current = created.id;
            }
            const calendarId = createdCalendarId.current;
            const result = await importCalendar.mutateAsync({ ...source, ownerId, calendarId });
            if (result.imported === 0) {
                await deleteCalendar.mutateAsync(calendarId);
                createdCalendarId.current = null;
            }
        },
        [createCalendar, deleteCalendar, importCalendar, ownerId],
    );

    const forgetNewCalendar = useCallback(() => {
        createdCalendarId.current = null;
    }, []);

    return { importToCalendar, forgetNewCalendar };
}
