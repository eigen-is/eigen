import {toast} from "sonner";
import {DrivePath} from "@apps/api-server/types/drive";
import {useRenamePath, useInvalidateFolder} from "@workspace/lib/drive";
import {DriveCreateItemDialog} from "./drive-create-folder-item";

export interface DriveRenameItemProps {
    path: DrivePath | null;
    open: boolean;
    onOpenChange: (open: boolean) => void;
    onSave?: (newName: string) => void;
    onCancel?: () => void;
    onAfterAction?: (actionType: string, data: any) => void;
}

export function DriveRenameItem({
    path,
    open,
    onOpenChange,
    onSave,
    onCancel,
    onAfterAction,
}: DriveRenameItemProps) {
    if (!path) return null;

    const renamePathMutation = useRenamePath(path.ownerId);
    const invalidateFolder = useInvalidateFolder();

    const handleOpenChange = (nextOpen: boolean) => {
        onOpenChange(nextOpen);
        if (!nextOpen && onCancel) onCancel();
    };

    const handleRename = async (newName: string) => {
        try {
            // Extract extension from original name
            const original = path.name;
            const dotIdx = original.lastIndexOf('.')
            let base = newName;
            let ext = '';
            // Only append extension for files (not folders)
            if (path.type !== 'folder' && dotIdx > 0) {
                ext = original.substring(dotIdx);
                // Remove any extension the user may have typed
                if (base.endsWith(ext)) {
                    base = base.slice(0, -ext.length);
                }
                newName = base + ext;
            }
            await renamePathMutation.mutateAsync({
                pathId: path.id,
                newName,
            });
            toast.success(`Renamed to "${newName}" successfully`);
            onOpenChange(false);

            // Invalidate parent folder to refresh contents
            invalidateFolder(path.id);

            // Call onAfterAction if provided
            if (onAfterAction) {
                onAfterAction('rename', {name: newName});
            }

            if (onSave) onSave(newName || '');
        } catch (error: any) {
            toast.error(error?.message || "Failed to rename");
        }
    };

    // Compute base name (without extension) for defaultValue
    let defaultValue = path.name;
    if (path.type !== 'folder') {
        const dotIdx = path.name.lastIndexOf('.');
        if (dotIdx > 0) {
            defaultValue = path.name.substring(0, dotIdx);
        }
    }

    return (
        <DriveCreateItemDialog
            open={open}
            onOpenChange={handleOpenChange}
            onCreateItem={handleRename}
            isPending={renamePathMutation.isPending}
            type="Rename"
            path={path}
            title={`Rename ${defaultValue}`}
            defaultValue={defaultValue}
            confirmLabel="Rename"
        />
    );
}
