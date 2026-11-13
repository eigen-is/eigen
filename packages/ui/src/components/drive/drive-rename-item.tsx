// The Rename dialog for one Drive item, which Drive's item menu and an editor's File menu open, for example. A plain
// file's field shows its whole name with the part before the extension selected, as Finder does, and the typed name is
// the new name, so the extension can change. An Eigen document hides its extension and gets it back on save, once, even
// when the user typed it. A folder keeps the name as typed.

import { useRenamePath } from '@workspace/lib/drive';
import type { DrivePath } from '@workspace/lib/types/drive';
import { isDocumentType, isFolderType, stripEigenExtension, withEigenExtension } from '@workspace/lib/types/drive';
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
    const documentType = isDocumentType(path.type) ? path.type : undefined;
    const name = documentType ? stripEigenExtension(path.name) : path.name;
    const extensionStart = path.name.lastIndexOf('.');

    const handleRename = async (typedName: string) => {
        const newName = documentType ? withEigenExtension(stripEigenExtension(typedName), documentType) : typedName;
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
            title={`Rename ${name}`}
            defaultValue={name}
            selectionEnd={isFolder || documentType || extensionStart <= 0 ? undefined : extensionStart}
            submitLabel="Rename"
        />
    );
}
