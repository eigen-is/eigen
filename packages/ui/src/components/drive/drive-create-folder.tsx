import { useCreateFolder } from '@workspace/lib/drive';
import type { DrivePath } from '@workspace/lib/types/drive';
import { DriveLocationPicker } from './drive-location-picker';

export type DriveCreateFolderProps = {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    defaultOwnerId?: string;
    defaultMountId?: string;
    defaultFolderId?: string;
    onAfterCreate?: (path: DrivePath) => void;
};

export function DriveCreateFolder({
    open,
    onOpenChange,
    defaultOwnerId,
    defaultMountId,
    defaultFolderId,
    onAfterCreate,
}: DriveCreateFolderProps) {
    const createMutation = useCreateFolder();

    const handleConfirm = async (location: { ownerId: string; mountId: string; folderId: string; name?: string }) => {
        if (!location.name?.trim()) return;
        const newFolder = await createMutation.mutateAsync({
            ownerId: location.ownerId,
            mountId: location.mountId,
            parentId: location.folderId,
            folderName: location.name.trim(),
        });
        if (newFolder) onAfterCreate?.(newFolder);
    };

    return (
        <DriveLocationPicker
            open={open}
            onOpenChange={onOpenChange}
            mode="create"
            onConfirm={handleConfirm}
            title="New folder"
            nameLabel="Folder name"
            confirmLabel="Create"
            defaultOwnerId={defaultOwnerId}
            defaultMountId={defaultMountId}
            defaultFolderId={defaultFolderId}
        />
    );
}
