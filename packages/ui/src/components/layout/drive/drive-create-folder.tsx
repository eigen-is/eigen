import { useCreateFolder } from '@workspace/lib/drive';
import type { DrivePath } from '@workspace/lib/types/drive';
import { DriveLocationPicker } from './drive-location-picker';

export type DriveCreateFolderProps = {
    path: DrivePath;
    open: boolean;
    onOpenChange: (open: boolean) => void;
    onSave?: (newPath: string) => void;
    onCancel?: () => void;
    onAfterAction?: (actionType: string, data: Record<string, unknown>) => void;
};

export function DriveCreateFolder({
    path,
    open,
    onOpenChange,
    onSave,
    onCancel,
    onAfterAction,
}: DriveCreateFolderProps) {
    const createFolderMutation = useCreateFolder(path.ownerId, path.mountId);

    const handleConfirm = async (location: { ownerId: string; mountId: string; folderId: string; name?: string }) => {
        if (!location.name?.trim()) return;
        const newFolder = await createFolderMutation.mutateAsync({
            parentId: location.folderId,
            folderName: location.name.trim(),
        });
        onOpenChange(false);
        onAfterAction?.('create', { name: location.name.trim() });
        onSave?.(newFolder?.id || '');
    };

    const handleOpenChange = (nextOpen: boolean) => {
        onOpenChange(nextOpen);
        if (!nextOpen) onCancel?.();
    };

    return (
        <DriveLocationPicker
            open={open}
            onOpenChange={handleOpenChange}
            mode="create"
            onConfirm={handleConfirm}
            title="New folder"
            nameLabel="Folder name"
            confirmLabel="Create"
            defaultOwnerId={path.ownerId}
            defaultMountId={path.mountId}
            defaultFolderId={path.id}
        />
    );
}
