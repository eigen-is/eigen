import {toast} from "sonner";
import type {DrivePath} from "@workspace/lib/types/drive";
import {useCreateSheets} from "@workspace/lib/drive";
import {getSheetUrl} from "@workspace/lib/api";
import {DriveCreateItemDialog} from "./drive-create-folder-item";

export type DriveCreateSheetsProps = {
    path: DrivePath;
    open: boolean;
    onOpenChange: (open: boolean) => void;
    onSave?: (newPath: string) => void;
    onCancel?: () => void;
    onAfterAction?: (actionType: string, data: any) => void;
}

export function DriveCreateSheets({
                                      path,
                                      open,
                                      onOpenChange,
                                      onSave,
                                      onCancel,
                                      onAfterAction,
                                  }: DriveCreateSheetsProps) {
    const createSheetsMutation = useCreateSheets(path.ownerId, path.mountId);

    const handleOpenChange = (nextOpen: boolean) => {
        onOpenChange(nextOpen);
        if (!nextOpen && onCancel) onCancel();
    };

    const handleCreateSheets = async (fileName: string) => {
        try {
            const newPath = await createSheetsMutation.mutateAsync({
                parentId: path.id,
                fileName: fileName,
            });
            onOpenChange(false);

            if (onAfterAction) {
                onAfterAction('create', {name: fileName});
            }

            if (newPath) {
                const url = getSheetUrl(path.ownerId, path.mountId, newPath.id);
                window.open(url, '_blank');
            }

            if (onSave) onSave(newPath?.id || '');
        } catch (error: unknown) {
            toast.error(error instanceof Error ? error.message : "Failed to create sheets");
        }
    };

    return (
        <DriveCreateItemDialog
            open={open}
            onOpenChange={handleOpenChange}
            onCreateItem={handleCreateSheets}
            isPending={createSheetsMutation.isPending}
            type="Sheets"
            path={path}
        />
    );
}
