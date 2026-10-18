import { useImportDocument, useImportFromDrive } from '@workspace/lib/drive';
import { CONVERT_SOURCES, type ConvertTarget, type DrivePath, isConvertSource } from '@workspace/lib/types/drive';
import { FileImportPicker } from './file-import-picker';

type DocumentImportPickerProps = {
    path: DrivePath;
    open: boolean;
    onOpenChange: (open: boolean) => void;
    title: string;
    progressTitle: string;
    target: ConvertTarget;
};

// The import picker docs, sheets and slides share: it binds both import mutations to the shared dialog and
// takes the titles and the document type as props. The toolbar keeps only the open state so its File menu
// can trigger it. A Drive file is offered by its extension, as Convert takes it: Drive stores the type its
// upload claimed, which for an Office file can be application/octet-stream.
export function DocumentImportPicker({
    path,
    open,
    onOpenChange,
    title,
    progressTitle,
    target,
}: DocumentImportPickerProps) {
    const importMutation = useImportDocument(path.ownerId, path.mountId);
    const importFromDriveMutation = useImportFromDrive(path.ownerId, path.mountId);

    return (
        <FileImportPicker
            open={open}
            onOpenChange={onOpenChange}
            title={title}
            accept={`.${CONVERT_SOURCES[target].format}`}
            canPick={(item) => isConvertSource(item.name, target)}
            onDeviceFile={(file) => importMutation.mutate({ pathId: path.id, file })}
            onDrivePick={(source) =>
                importFromDriveMutation.mutate({
                    pathId: path.id,
                    sourceOwnerId: source.ownerId,
                    sourceMountId: source.mountId,
                    sourcePathId: source.id,
                })
            }
            pending={importMutation.isPending || importFromDriveMutation.isPending}
            progressTitle={progressTitle}
        />
    );
}
