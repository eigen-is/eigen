// The Drive file picker with Upload from device beside it, for a surface that takes a file from either place, such
// as an editor's Insert image or a mail attachment. Each source hands its files to its own callback, and the picker
// closes after a device pick.

import type { DrivePath } from '@workspace/lib/types/drive';
import type { ChangeEvent } from 'react';
import { useRef } from 'react';
import { DriveFilePicker } from './drive-file-picker';

type DrivePickerWithUploadProps = {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    title?: string;
    submitLabel?: string;
    canPick?: (item: DrivePath) => boolean;
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
    submitLabel,
    canPick,
    multiSelect,
    onPickFromDrive,
    onPickFromDevice,
    accept,
    multiple,
}: DrivePickerWithUploadProps) {
    const inputRef = useRef<HTMLInputElement>(null);

    // The picker stays open over the native file chooser: closing it first unmounts this input
    // wherever the caller renders the picker conditionally, and the chooser then never opens.
    const triggerUpload = () => inputRef.current?.click();

    const handleFileChange = (e: ChangeEvent<HTMLInputElement>) => {
        const files = e.target.files ? Array.from(e.target.files) : [];
        e.target.value = '';
        if (files.length === 0) return;
        onPickFromDevice?.(files);
        onOpenChange(false);
    };

    return (
        <>
            <DriveFilePicker
                open={open}
                onOpenChange={onOpenChange}
                title={title}
                submitLabel={submitLabel}
                canPick={canPick}
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
