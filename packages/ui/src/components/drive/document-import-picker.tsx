import { useImportDocument, useImportFromDrive } from '@workspace/lib/drive';
import type { DrivePath } from '@workspace/lib/types/drive';
import { FileImportPicker } from './file-import-picker';

type DocumentImportPickerProps = {
    path: DrivePath;
    open: boolean;
    onOpenChange: (open: boolean) => void;
    title: string;
    mime: string;
    accept: string;
};

// The import picker docs and sheets share: it binds both import mutations to the shared dialog and
// takes the per-type literals (title, mime, accept) as props. The toolbar keeps only the open state
// so its File menu can trigger it.
export function DocumentImportPicker({ path, open, onOpenChange, title, mime, accept }: DocumentImportPickerProps) {
    const importMutation = useImportDocument(path.ownerId, path.mountId);
    const importFromDriveMutation = useImportFromDrive(path.ownerId, path.mountId);

    return (
        <FileImportPicker
            open={open}
            onOpenChange={onOpenChange}
            title={title}
            accept={accept}
            canPick={(item) => item.mimeType === mime}
            onDeviceFile={(file) => importMutation.mutate({ pathId: path.id, file })}
            onDrivePick={(source) =>
                importFromDriveMutation.mutate({
                    pathId: path.id,
                    sourceOwnerId: source.ownerId,
                    sourceMountId: source.mountId,
                    sourcePathId: source.id,
                })
            }
        />
    );
}
