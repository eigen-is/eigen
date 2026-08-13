import { useImportDocument, useImportFromDrive } from '@workspace/lib/drive';
import type { DrivePath } from '@workspace/lib/types/drive';
import { DrivePickerWithUpload } from './drive-picker-with-upload';

type DocumentImportPickerProps = {
    path: DrivePath;
    open: boolean;
    onOpenChange: (open: boolean) => void;
    title: string;
    mime: string;
    accept: string;
};

// The import picker docs and sheets share: it owns both import mutations and the
// device/drive pick handlers, and takes the per-type literals (title, mime, accept)
// as props. The toolbar keeps only the open state so its File menu can trigger it.
export function DocumentImportPicker({ path, open, onOpenChange, title, mime, accept }: DocumentImportPickerProps) {
    const importMutation = useImportDocument(path.ownerId, path.mountId);
    const importFromDriveMutation = useImportFromDrive(path.ownerId, path.mountId);

    const handleImportFromDrive = (paths: DrivePath[]) => {
        const source = paths[0];
        if (!source) return;
        importFromDriveMutation.mutate({
            pathId: path.id,
            sourceOwnerId: source.ownerId,
            sourceMountId: source.mountId,
            sourcePathId: source.id,
        });
    };

    const handleImportFromDevice = (files: File[]) => {
        const file = files[0];
        if (file) importMutation.mutate({ pathId: path.id, file });
    };

    return (
        <DrivePickerWithUpload
            open={open}
            onOpenChange={onOpenChange}
            title={title}
            mimeFilter={[mime]}
            onPickFromDrive={handleImportFromDrive}
            onPickFromDevice={handleImportFromDevice}
            accept={accept}
        />
    );
}
