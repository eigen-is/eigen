import { triggerDownload } from '@workspace/lib/download';
import { useCopyFiles } from '@workspace/lib/drive';
import type { DrivePath } from '@workspace/lib/types/drive';
import type { FileSubject } from '@workspace/lib/types/file-subject';
import { useEffect, useRef } from 'react';
import { useOptionalPreview } from '../preview-provider/preview-context';
import { DriveLocationPicker } from './drive-location-picker';

type SaveToDrivePickerProps = {
    subjects: FileSubject[];
    open: boolean;
    onClose: () => void;
};

// One "where does this go" dialog for every surface that puts a file into Drive, with the browser
// download as the escape hatch. A Drive subject is copied server-side, so its bytes never travel.
export function SaveToDrivePicker({ subjects, open, onClose }: SaveToDrivePickerProps) {
    const preview = useOptionalPreview();
    const paths = subjects.map((subject) => subject.drive).filter((path): path is DrivePath => path !== undefined);
    const source = paths[0];
    // The batch comes from one folder, so every path shares the first one's source mount.
    const copyFiles = useCopyFiles(source?.ownerId ?? '', source?.mountId);
    const downloadTimers = useRef<ReturnType<typeof setTimeout>[]>([]);
    useEffect(
        () => () => {
            for (const timer of downloadTimers.current) clearTimeout(timer);
        },
        [],
    );

    if (!source) return null;

    // Staggered: a browser drops the second and later downloads of a burst fired in one tick.
    const downloadAll = () => {
        for (const timer of downloadTimers.current) clearTimeout(timer);
        downloadTimers.current = subjects.map((subject, i) =>
            setTimeout(() => {
                if (subject.downloadUrl) triggerDownload(subject.downloadUrl);
            }, i * 300),
        );
    };

    return (
        <DriveLocationPicker
            open={open}
            onOpenChange={(next) => {
                if (!next) onClose();
            }}
            // The picker opens over the preview overlay when one is showing, and has to outrank it.
            abovePreview={preview?.isPreviewOpen}
            mode="folder"
            title={subjects.length > 1 ? `Save ${subjects.length} files to Drive` : 'Save to Drive'}
            confirmLabel="Save here"
            defaultOwnerId={source.ownerId}
            defaultMountId={source.mountId}
            onConfirm={async (location) => {
                // Await the copy so the picker closes on success and stays open (with the failure
                // toast) on error, instead of closing immediately.
                await copyFiles.mutateAsync({
                    pathIds: paths.map((path) => path.id),
                    targetOwnerId: location.ownerId,
                    targetMountId: location.mountId,
                    targetParentId: location.folderId,
                });
            }}
            onDownloadInstead={() => {
                onClose();
                downloadAll();
            }}
        />
    );
}
