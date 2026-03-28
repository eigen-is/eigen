import {getStickiesBoardUrl} from '@workspace/lib/api';
import {useCreateStickies} from '@workspace/lib/drive';
import type {DrivePath} from '@workspace/lib/types/drive';
import {DriveCreateItemDialog} from './drive-create-folder-item';

export type DriveCreateStickiesProps = {
    path: DrivePath;
    open: boolean;
    onOpenChange: (open: boolean) => void;
    onSave?: (newPath: string) => void;
    onCancel?: () => void;
    onAfterAction?: (actionType: string, data: Record<string, unknown>) => void;
};

export function DriveCreateStickies({
                                        path,
                                        open,
                                        onOpenChange,
                                        onSave,
                                        onCancel,
                                        onAfterAction,
                                    }: DriveCreateStickiesProps) {
    const createStickiesMutation = useCreateStickies(path.ownerId, path.mountId);

    const handleOpenChange = (nextOpen: boolean) => {
        onOpenChange(nextOpen);
        if (!nextOpen && onCancel) onCancel();
    };

    const handleCreateStickies = async (fileName: string) => {
        const newPath = await createStickiesMutation.mutateAsync({
            parentId: path.id,
            fileName: fileName,
        });
        onOpenChange(false);

        // Call onAfterAction if provided
        if (onAfterAction) {
            onAfterAction('create', {name: fileName});
        }

        // Open the stickies board in a new window
        if (newPath) {
            const url = getStickiesBoardUrl(path.ownerId, path.mountId, newPath.id);
            window.open(url, '_blank');
        }

        if (onSave) onSave(newPath?.id || '');
    };

    return (
        <DriveCreateItemDialog
            open={open}
            onOpenChange={handleOpenChange}
            onCreateItem={handleCreateStickies}
            isPending={createStickiesMutation.isPending}
            type="Stickies"
            path={path}
        />
    );
}
