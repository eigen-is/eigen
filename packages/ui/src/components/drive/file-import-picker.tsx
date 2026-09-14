import type { DrivePath } from '@workspace/lib/types/drive';
import { DrivePickerWithUpload } from './drive-picker-with-upload';

type FileImportPickerProps = {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    title: string;
    accept: string;
    // Which drive rows are pickable.
    canPick: (item: DrivePath) => boolean;
    onDeviceFile: (file: File) => void;
    onDrivePick: (item: DrivePath) => void;
};

// The "import one file" dialog: pick a file from Drive or upload one from the device. It owns no
// mutation — the caller binds both handlers to whatever its import means.
export function FileImportPicker({
    open,
    onOpenChange,
    title,
    accept,
    canPick,
    onDeviceFile,
    onDrivePick,
}: FileImportPickerProps) {
    return (
        <DrivePickerWithUpload
            open={open}
            onOpenChange={onOpenChange}
            title={title}
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
    );
}
