import { type QueryClient, useMutation, useQueryClient } from '@tanstack/react-query';
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

// The transfer routes resolve only the viewer's own home and a team's, so a calendar shared out of another home is refused.
export function isTransferableCalendarHome(ownerId: string, viewerId: string): boolean {
    return ownerId === viewerId || parseOwnerId(ownerId).type === 'team';
}

// The export answers with the file itself, so it takes raw fetch over Eden and reports its own failures.
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

type ImportCalendarTargetIds = { ownerId: string; calendarId: string };

// One landing place for every import path: the events are in the calendar, so the open range refreshes, and the
// counts are reported in the wording every counted import shares.
function reportImport(queryClient: QueryClient, ownerId: string, result: ImportCountsResult): void {
    invalidateEventList(queryClient, ownerId);
    reportImportCounts(result, 'event');
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

// A mail part or chat attachment has no Drive path for the server to copy, so the browser reads its bytes and posts them.
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

export type ImportCalendarTarget =
    | { kind: 'existing'; ownerId: string; calendarId: string }
    | { kind: 'new'; name: string; color: string };

// A new calendar that took no events is deleted again, and a failed attempt's calendar is remembered so a retry reuses it.
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
