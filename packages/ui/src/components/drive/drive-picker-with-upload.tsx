import type { DrivePath } from '@workspace/lib/types/drive';
import { useRef } from 'react';
import { DriveFilePicker } from './drive-file-picker';

type DrivePickerWithUploadProps = {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    title?: string;
    mimeFilter?: string[];
    multiSelect?: boolean;
    onPickFromDrive: (paths: DrivePath[]) => void;
    // Omit to hide the "Upload from device" button in the picker.
    onPickFromDevice?: (files: File[]) => void;
    accept?: string;
    multiple?: boolean;
};

export function DrivePickerWithUpload({
    open,
    onOpenChange,
    title,
    mimeFilter,
    multiSelect,
    onPickFromDrive,
    onPickFromDevice,
    accept,
    multiple,
}: DrivePickerWithUploadProps) {
    const inputRef = useRef<HTMLInputElement>(null);

    const triggerUpload = () => {
        // Close the picker first so focus can move to the native file chooser cleanly.
        onOpenChange(false);
        setTimeout(() => inputRef.current?.click(), 0);
    };

    const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        const files = e.target.files ? Array.from(e.target.files) : [];
        if (files.length > 0) onPickFromDevice?.(files);
        e.target.value = '';
    };

    return (
        <>
            <DriveFilePicker
                open={open}
                onOpenChange={onOpenChange}
                title={title}
                mimeFilter={mimeFilter}
                multiSelect={multiSelect}
                onSelect={onPickFromDrive}
                onUploadFromDevice={onPickFromDevice ? triggerUpload : undefined}
            />
            {onPickFromDevice && (
                <input
                    ref={inputRef}
                    type="file"
                    accept={accept}
                    multiple={multiple}
                    className="hidden"
                    onChange={handleFileChange}
                />
            )}
        </>
    );
}
