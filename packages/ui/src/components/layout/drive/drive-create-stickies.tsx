import {toast} from "sonner";
import {DrivePath} from "@apps/api-server/types/drive";
import {useCreateStickies, useInvalidateFolder} from "@workspace/lib/drive";
import {DriveCreateItemDialog} from "./drive-create-folder-item";

export interface DriveCreateStickiesProps {
    path: DrivePath;
    open: boolean;
    onOpenChange: (open: boolean) => void;
    onSave?: (newPath: string) => void;
    onCancel?: () => void;
    onAfterAction?: (actionType: string, data: any) => void;
}

export function DriveCreateStickies({
                                        path,
                                        open,
                                        onOpenChange,
                                        onSave,
                                        onCancel,
                                        onAfterAction,
                                    }: DriveCreateStickiesProps) {
    const createStickiesMutation = useCreateStickies(path.ownerId);
    const invalidateFolder = useInvalidateFolder();

    const handleOpenChange = (nextOpen: boolean) => {
        onOpenChange(nextOpen);
        if (!nextOpen && onCancel) onCancel();
    };

    const handleCreateStickies = async (fileName: string) => {
        try {
            const newPath = await createStickiesMutation.mutateAsync({
                parentId: path.id,
                fileName: fileName,
            }) as string | undefined;
            toast.success(`Stickies "${fileName}" created successfully`);
            onOpenChange(false);

            // Invalidate folder to refresh the folder contents
            invalidateFolder(path.id);

            // Call onAfterAction if provided
            if (onAfterAction) {
                onAfterAction('create', {name: fileName});
            }

            // Open the stickies board in a new window
            if (newPath) {
                const url = `${import.meta.env.VITE_APP_STICKIES_URL}/board/${path.ownerId}/${newPath}`;
                window.open(url, '_blank');
            }

            if (onSave) onSave(newPath || '');
        } catch (error: any) {
            toast.error(error?.message || "Failed to create stickies");
        }
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
