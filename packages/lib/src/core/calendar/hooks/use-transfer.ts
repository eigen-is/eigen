// The hooks that move events in and out of a calendar: the .ics export, and imports from a file on the device, from
// a mail part or chat attachment, or into a new calendar. Each import reports its counts with the wording every
// counted import shares, and says the events it skipped are already in the home's calendars.

import type { QueryClient } from '@tanstack/react-query';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { calendarApi, getCalendarExportUrl, getCalendarImportUrl } from '@workspace/lib/api';
import { parseOwnerId } from '@workspace/lib/types';
import { ICS_MIME } from '@workspace/lib/types/file-kinds';
import type { FileImportSource } from '@workspace/lib/types/file-subject';
import type { ImportCountsResult } from '@workspace/lib/types/transfer';
import { useCallback, useRef } from 'react';
import { AppError, onMutationError } from '../../api-error';
import { useFileDownload } from '../../download';
import { fetchImportBlob, postImportBytes, reportImportCounts } from '../../transfer';
import { invalidateEventList } from './keys';
import { useCreateCalendar, useDeleteCalendar } from './use-calendar';

// The transfer routes resolve only the viewer's own home and a team's, so a calendar shared out of another home is
// refused.
export function isTransferableCalendarHome(ownerId: string, viewerId: string): boolean {
    return ownerId === viewerId || parseOwnerId(ownerId).type === 'team';
}

// The export answers with the file itself, so it takes raw fetch over Eden and reports its own failures.
export function useExportCalendar(): {
    exportCalendar: (ownerId: string, calendarId: string, ids?: string[]) => Promise<Headers | null>;
    isExporting: boolean;
} {
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

type ImportCalendarTargetIds = { ownerId: string; calendarId: string };

// One landing place for every import path: the events are in the calendar, so the open range refreshes, and the
// counts are reported in the wording every counted import shares. A skipped event's UID is already in one of the
// target home's calendars, and a team calendar's import checks the team's calendars, not the viewer's.
function reportImport(queryClient: QueryClient, ownerId: string, result: ImportCountsResult): void {
    invalidateEventList(queryClient, ownerId);
    const alreadyIn = parseOwnerId(ownerId).type === 'team' ? 'this team’s calendars' : 'your calendars';
    reportImportCounts(result, 'event', alreadyIn);
}

// The file the user picked off their own disk, posted as the raw body the route reads as one iCalendar stream.
export function useImportCalendarFromDevice() {
    const queryClient = useQueryClient();

    return useMutation({
        mutationFn: ({
            file,
            ownerId,
            calendarId,
        }: ImportCalendarTargetIds & { file: File }): Promise<ImportCountsResult> =>
            postImportBytes(getCalendarImportUrl(ownerId, calendarId), ICS_MIME, file),
        onSuccess: (result, { ownerId }) => reportImport(queryClient, ownerId, result),
        onError: onMutationError,
    });
}

// A mail part or chat attachment has no Drive path for the server to copy, so the browser reads its bytes and posts
// them.
export function useImportCalendar() {
    const queryClient = useQueryClient();

    return useMutation({
        mutationFn: async (source: FileImportSource & ImportCalendarTargetIds): Promise<ImportCountsResult> => {
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
        onSuccess: (result, { ownerId }) => reportImport(queryClient, ownerId, result),
        onError: onMutationError,
    });
}

type ImportCalendarTarget =
    | { kind: 'existing'; ownerId: string; calendarId: string }
    | { kind: 'new'; name: string; color: string };

// A new calendar is made in the viewer's own home and the file imported into it. When the import fails or takes no
// events, the calendar is deleted again at once. When that delete fails too, the calendar is remembered, and the next
// try deletes it first, so no events land under a name the user did not ask for. A retry that picks it from the list
// keeps it and imports there.
export function useImportToCalendar(ownerId: string): {
    importToCalendar: (source: FileImportSource, target: ImportCalendarTarget) => Promise<void>;
} {
    const createCalendar = useCreateCalendar(ownerId);
    const deleteCalendar = useDeleteCalendar(ownerId);
    const importCalendar = useImportCalendar();
    const leftoverCalendarId = useRef<string | null>(null);

    const importToCalendar = useCallback(
        async (source: FileImportSource, target: ImportCalendarTarget) => {
            const leftover = leftoverCalendarId.current;
            if (target.kind === 'existing' && target.calendarId === leftover) {
                leftoverCalendarId.current = null;
            } else if (leftover) {
                // The delete's hook toasts its own failure. The import goes on either way, and the next try deletes
                // it again.
                await deleteCalendar.mutateAsync(leftover).then(
                    () => {
                        leftoverCalendarId.current = null;
                    },
                    () => {},
                );
            }
            if (target.kind === 'existing') {
                await importCalendar.mutateAsync({ ...source, ownerId: target.ownerId, calendarId: target.calendarId });
                return;
            }
            const { id: calendarId } = await createCalendar.mutateAsync({ name: target.name, color: target.color });
            const discard = async () => {
                leftoverCalendarId.current = calendarId;
                await deleteCalendar.mutateAsync(calendarId);
                leftoverCalendarId.current = null;
            };
            const result = await importCalendar.mutateAsync({ ...source, ownerId, calendarId }).catch(async (error) => {
                // The delete's hook toasts its own failure, and the caller must still see why the import failed.
                await discard().catch(() => {});
                throw error;
            });
            if (result.imported === 0) await discard();
        },
        [createCalendar, deleteCalendar, importCalendar, ownerId],
    );

    return { importToCalendar };
}
