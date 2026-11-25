// The "import one file" dialog, such as Import events or Import contacts: pick a file from Drive or upload one from
// the device, then the shared progress dialog while the import runs. It owns no mutation: the caller binds both
// handlers to whatever its import means.

import type { DrivePath } from '@workspace/lib/types/drive';
import { DrivePickerWithUpload } from './drive-picker-with-upload';
import { ProgressDialog } from './progress-dialog';

type FileImportPickerProps = {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    title: string;
    // Import, unless the pick is a step before the import, such as a choice of how it comes in.
    submitLabel?: string;
    accept: string;
    // Which drive rows are pickable.
    canPick: (item: DrivePath) => boolean;
    onDeviceFile: (file: File) => void;
    onDrivePick: (item: DrivePath) => void;
    // The caller's import is running; a big file takes a while.
    pending: boolean;
    progressTitle: string;
};

export function FileImportPicker({
    open,
    onOpenChange,
    title,
    submitLabel = 'Import',
    accept,
    canPick,
    onDeviceFile,
    onDrivePick,
    pending,
    progressTitle,
}: FileImportPickerProps) {
    return (
        <>
            <DrivePickerWithUpload
                open={open}
                onOpenChange={onOpenChange}
                title={title}
                submitLabel={submitLabel}
                canPick={canPick}
                accept={accept}
                onPickFromDrive={(paths) => {
                    const source = paths[0];
                    if (source) onDrivePick(source);
                }}
                onPickFromDevice={(files) => {
                    const file = files[0];
                    if (file) onDeviceFile(file);
                }}
            />
            <ProgressDialog open={pending} title={progressTitle} />
        </>
    );
}
