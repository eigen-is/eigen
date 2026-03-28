import {getDocUrl} from '@workspace/lib/api';
import {useCreateDoc} from '@workspace/lib/drive';
import type {DrivePath} from '@workspace/lib/types/drive';
import {DriveCreateItemDialog} from './drive-create-folder-item';

export type DriveCreateDocProps = {
    path: DrivePath;
    open: boolean;
    onOpenChange: (open: boolean) => void;
    onSave?: (newPath: string) => void;
    onCancel?: () => void;
    onAfterAction?: (actionType: string, data: Record<string, unknown>) => void;
};

export function DriveCreateDoc({path, open, onOpenChange, onSave, onCancel, onAfterAction}: DriveCreateDocProps) {
    const createDocMutation = useCreateDoc(path.ownerId, path.mountId);

    const handleOpenChange = (nextOpen: boolean) => {
        onOpenChange(nextOpen);
        if (!nextOpen && onCancel) onCancel();
    };

    const handleCreateDoc = async (fileName: string) => {
        const newPath = await createDocMutation.mutateAsync({
            parentId: path.id,
            fileName: fileName,
        });
        onOpenChange(false);

        // Call onAfterAction if provided
        if (onAfterAction) {
            onAfterAction('create', {name: fileName});
        }

        // Open the document in a new window
        if (newPath) {
            const url = getDocUrl(path.ownerId, path.mountId, newPath.id);
            window.open(url, '_blank');
        }

        if (onSave) onSave(newPath?.id || '');
    };

    return (
        <DriveCreateItemDialog
            open={open}
            onOpenChange={handleOpenChange}
            onCreateItem={handleCreateDoc}
            isPending={createDocMutation.isPending}
            type="Document"
            path={path}
        />
    );
}
