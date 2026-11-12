// The Rename dialog for one Drive item, which Drive's item menu and an editor's File menu open, for example. A file is
// renamed without its extension: the field shows the name before the last dot, and the save puts the extension back,
// once, even when the user typed it. A folder keeps the name as typed.

import { useRenamePath } from '@workspace/lib/drive';
import type { DrivePath } from '@workspace/lib/types/drive';
import { isFolderType } from '@workspace/lib/types/drive';
import { DriveItemNameDialog } from './drive-item-name-dialog';

export type DriveRenameItemProps = {
    path: DrivePath;
    open: boolean;
    onOpenChange: (open: boolean) => void;
    onAfterAction?: (actionType: string, data: Record<string, unknown>) => void;
};

export function DriveRenameItem({ path, open, onOpenChange, onAfterAction }: DriveRenameItemProps) {
    const renamePathMutation = useRenamePath();
    const isFolder = isFolderType(path.type);
    const dotIndex = path.name.lastIndexOf('.');
    // A leading dot, as in .gitignore, is part of the name rather than an extension.
    const extension = !isFolder && dotIndex > 0 ? path.name.slice(dotIndex) : '';
    const baseName = path.name.slice(0, path.name.length - extension.length);

    const handleRename = async (typedName: string) => {
        const newName = typedName.endsWith(extension) ? typedName : typedName + extension;
        await renamePathMutation.mutateAsync({ path, newName });
        onAfterAction?.('rename', { name: newName });
    };

    return (
        <DriveItemNameDialog
            open={open}
            onOpenChange={onOpenChange}
            onSave={handleRename}
            type={isFolder ? 'Folder' : 'File'}
            path={path}
            title={`Rename ${baseName}`}
            defaultValue={baseName}
            submitLabel="Rename"
        />
    );
}
