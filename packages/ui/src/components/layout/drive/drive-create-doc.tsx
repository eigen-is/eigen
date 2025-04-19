import {toast} from "sonner";
import {DrivePath} from "@apps/api-server/types/drive";
import {useCreateDoc, useInvalidateFolder} from "@workspace/lib/drive";
import {DriveCreateItemDialog} from "./drive-create-folder-item";

export interface DriveCreateDocProps {
    path: DrivePath;
    open: boolean;
    onOpenChange: (open: boolean) => void;
    onSave?: (newPath: string) => void;
    onCancel?: () => void;
    onAfterAction?: (actionType: string, data: any) => void;
}

export function DriveCreateDoc({
    path,
    open,
    onOpenChange,
    onSave,
    onCancel,
    onAfterAction,
}: DriveCreateDocProps) {
    const createDocMutation = useCreateDoc(path.ownerId);
    const invalidateFolder = useInvalidateFolder();

    const handleOpenChange = (nextOpen: boolean) => {
        onOpenChange(nextOpen);
        if (!nextOpen && onCancel) onCancel();
    };

    const handleCreateDoc = async (fileName: string) => {
        try {
            const newPath = await createDocMutation.mutateAsync({
                parentId: path.id,
                fileName: fileName,
            });
            toast.success(`Doc "${fileName}" created successfully`);
            onOpenChange(false);
            
            // Invalidate folder to refresh the folder contents
            invalidateFolder(path.id);
            
            // Call onAfterAction if provided
            if (onAfterAction) {
                onAfterAction('create', {name: fileName});
            }
            
            // Open the document in a new window
            if (newPath) {
                const url = `${import.meta.env.VITE_APP_DOCS_URL}/doc/${path.ownerId}/${newPath}`;
                window.open(url, '_blank');
            }
            
            if (onSave) onSave(newPath || '');
        } catch (error: any) {
            toast.error(error?.message || "Failed to create document");
        }
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
