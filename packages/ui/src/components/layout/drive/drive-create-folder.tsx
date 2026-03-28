import {useCreateFolder} from '@workspace/lib/drive';
import type {DrivePath} from '@workspace/lib/types/drive';
import {DriveCreateItemDialog} from './drive-create-folder-item';

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

    const handleOpenChange = (nextOpen: boolean) => {
        onOpenChange(nextOpen);
        if (!nextOpen && onCancel) onCancel();
    };

    const handleCreateFolder = async (folderName: string) => {
        const newPath = await createFolderMutation.mutateAsync({
            parentId: path.id,
            folderName: folderName,
        });
        onOpenChange(false);

        // Call onAfterAction if provided
        if (onAfterAction) {
            onAfterAction('create', {name: folderName});
        }

        if (onSave) onSave(newPath?.id || '');
    };

    return (
        <DriveCreateItemDialog
            open={open}
            onOpenChange={handleOpenChange}
            onCreateItem={handleCreateFolder}
            isPending={createFolderMutation.isPending}
            type="Folder"
            path={path}
        />
    );
}
