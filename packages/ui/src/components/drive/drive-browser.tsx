// A small Drive browser for picking a file or a folder: a mount list, a breadcrumb and a bare table
// whose rows have no actions. Pickers and the location field draw it, for example the Copy to… picker.
// Its host holds the location: the browser shows the one it is given and asks for another through onChange.
// A location with no folder id means the mount's root, which useResolvedDriveLocation fills in.

import {
    getDriveComparator,
    useBreadcrumb,
    useCreateFolder,
    useFolderContent,
    useResolvedDriveLocation,
} from '@workspace/lib/drive';
import type { DrivePath } from '@workspace/lib/types/drive';
import { isFolderType } from '@workspace/lib/types/drive';
import type { DriveLocationValue } from '@workspace/lib/types/drive-view';
import { DropdownMenuItem } from '@workspace/ui/components/dropdown-menu';
import { cn } from '@workspace/ui/lib/utils';
import { FolderPlus } from 'lucide-react';
import { useMemo } from 'react';
import { ContextMenuAnchor, useContextMenu } from '../context-menu';
import { DriveBreadcrumb } from './drive-breadcrumb';
import { DriveItemNameDialog } from './drive-item-name-dialog';
import { DriveMountList, useMountLabel } from './drive-mount-list';
import type { DriveSortControl } from './drive-table';
import { DriveTable, useDriveSort } from './drive-table';

type DriveBrowserProps = {
    value: DriveLocationValue;
    onChange: (value: DriveLocationValue) => void;
    mode: 'file' | 'folder';
    // Which rows are pickable; every row when omitted.
    canPick?: (item: DrivePath) => boolean;
    selectedId?: string;
    onSelect?: (path: DrivePath) => void;
    onConfirm?: (path: DrivePath) => void;
    hideToolbar?: boolean;
    hideHeader?: boolean;
    // The open state of the New folder dialog, held by the host that draws its button. Without it, the browser
    // offers no new folder.
    newFolder?: { open: boolean; onOpenChange: (open: boolean) => void };
    onSelectionChange?: (items: DrivePath[]) => void;
    ownMountsOnly?: boolean;
    sort?: DriveSortControl;
    className?: string;
};

export function DriveBrowser({
    value,
    onChange,
    mode,
    canPick,
    selectedId,
    onSelect,
    onConfirm,
    hideToolbar,
    hideHeader,
    newFolder,
    onSelectionChange,
    ownMountsOnly,
    sort,
    className,
}: DriveBrowserProps) {
    // The "New folder" menu a right-click on the listing area opens. A right-click on a row opens nothing,
    // since the rows stop it from reaching the listing.
    const newFolderMenu = useContextMenu<true>();

    const { ownerId, mountId, folderId } = useResolvedDriveLocation(value);
    const mountLabel = useMountLabel(ownerId, mountId);
    const { data: folderContents = [] } = useFolderContent(ownerId, mountId, folderId);
    const { key: sortKey, dir: sortDir } = useDriveSort(sort);
    const sortedContents = useMemo(
        () => [...folderContents].sort(getDriveComparator(sortKey, sortDir)),
        [folderContents, sortKey, sortDir],
    );
    const { data: breadcrumbPaths = [] } = useBreadcrumb(ownerId, mountId, folderId);
    const createFolder = useCreateFolder();
    const currentPath = breadcrumbPaths.at(-1);

    const isItemDisabled = (item: DrivePath) =>
        !isFolderType(item.type) && (mode === 'folder' || canPick?.(item) === false);
    const openFolder = (folder: DrivePath) => onChange({ ownerId: folder.ownerId, mountId, folderId: folder.id });

    const handleItemClick = (item: DrivePath) => {
        if (isItemDisabled(item)) return;
        if (isFolderType(item.type)) {
            openFolder(item);
        } else if (onConfirm && selectedId === item.id) {
            // A click on the row that is already selected confirms it, so the user need not go to the Select button.
            onConfirm(item);
        } else {
            onSelect?.(item);
        }
    };

    return (
        <div className={cn('flex h-full', className)}>
            <div className="hidden sm:block w-44 border-r p-2 overflow-y-auto shrink-0">
                <DriveMountList
                    activeMountId={mountId}
                    activeOwnerId={ownerId}
                    onMountSelect={(mountOwnerId, pickedMountId) =>
                        onChange({ ownerId: mountOwnerId, mountId: pickedMountId, folderId: '' })
                    }
                    ownMountsOnly={ownMountsOnly}
                />
            </div>
            <div
                className="flex-1 flex flex-col min-w-0"
                onContextMenu={newFolder ? (e) => newFolderMenu.handleContextMenu(e, true) : undefined}
            >
                {!hideToolbar && (
                    <div className="flex items-center gap-2 h-10 app-gutter-x border-b shrink-0">
                        <DriveBreadcrumb
                            paths={breadcrumbPaths}
                            mountLabel={mountLabel}
                            onNavigate={openFolder}
                            className="flex-1"
                        />
                    </div>
                )}
                <DriveTable
                    items={sortedContents}
                    activeItemId={selectedId}
                    onItemClick={handleItemClick}
                    isItemDisabled={isItemDisabled}
                    hideModified
                    hideOwner
                    hideShareClick
                    hideActions
                    hideHeader={hideHeader}
                    onSelectionChange={onSelectionChange}
                    sort={sort}
                />
            </div>
            {newFolder && (
                <ContextMenuAnchor contextMenu={newFolderMenu} className="min-w-48">
                    <DropdownMenuItem
                        onClick={() => {
                            newFolder.onOpenChange(true);
                            newFolderMenu.close();
                        }}
                    >
                        <FolderPlus className="h-4 w-4" />
                        New folder
                    </DropdownMenuItem>
                </ContextMenuAnchor>
            )}
            {newFolder && currentPath && (
                <DriveItemNameDialog
                    open={newFolder.open}
                    onOpenChange={newFolder.onOpenChange}
                    onSave={async (folderName) =>
                        openFolder(await createFolder.mutateAsync({ ownerId, mountId, parentId: folderId, folderName }))
                    }
                    type="Folder"
                    path={currentPath}
                />
            )}
        </div>
    );
}
