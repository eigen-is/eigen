import { useRenamePath } from '@workspace/lib/drive';
import type { DrivePath } from '@workspace/lib/types/drive';
import { DriveCreateItemDialog } from './drive-create-folder-item';

export type DriveRenameItemProps = {
    path: DrivePath | null;
    open: boolean;
    onOpenChange: (open: boolean) => void;
    onSave?: (newName: string) => void;
    onCancel?: () => void;
    onAfterAction?: (actionType: string, data: Record<string, unknown>) => void;
};

export function DriveRenameItem({ path, open, onOpenChange, onSave, onCancel, onAfterAction }: DriveRenameItemProps) {
    if (!path) return null;

    const renamePathMutation = useRenamePath(
        path.ownerId,
        path.mountId,
        path.parentId || undefined,
        path.mimeType || undefined,
    );

    const handleOpenChange = (nextOpen: boolean) => {
        onOpenChange(nextOpen);
        if (!nextOpen && onCancel) onCancel();
    };

    const handleRename = async (newName: string) => {
        // Extract extension from original name
        const original = path.name;
        const dotIdx = original.lastIndexOf('.');
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
        onOpenChange(false);

        // Call onAfterAction if provided
        if (onAfterAction) {
            onAfterAction('rename', { name: newName });
        }

        if (onSave) onSave(newName || '');
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
