// A small Drive browser for picking a file or a folder: a mount list, a breadcrumb and a bare table
// whose rows have no actions. Pickers and the location field draw it, for example the Copy to… picker,
// and it reports the folder it is in and the rows the user picks. A folder picker can also make a new folder there.

import {
    DEFAULT_MOUNT_ID,
    getDriveComparator,
    useBreadcrumb,
    useCreateFolder,
    useFolderContent,
    useRootFolder,
} from '@workspace/lib/drive';
import type { DrivePath } from '@workspace/lib/types/drive';
import { isFolderType } from '@workspace/lib/types/drive';
import { Button } from '@workspace/ui/components/button';
import { DropdownMenuItem } from '@workspace/ui/components/dropdown-menu';
import { cn } from '@workspace/ui/lib/utils';
import { FolderPlus } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ContextMenuAnchor, useContextMenu } from '../context-menu';
import { DriveBreadcrumb } from './drive-breadcrumb';
import { DriveItemNameDialog } from './drive-item-name-dialog';
import { DriveMountList, useMountLabel } from './drive-mount-list';
import type { DriveSortControl } from './drive-table';
import { DriveTable, useDriveSort } from './drive-table';

type DriveBrowserProps = {
    ownerId: string;
    mode: 'file' | 'folder';
    // Which rows are pickable; every row when omitted.
    canPick?: (item: DrivePath) => boolean;
    selectedId?: string | null;
    onSelect?: (path: DrivePath) => void;
    onConfirm?: (path: DrivePath) => void;
    onFolderChange?: (folder: DrivePath, mountId: string) => void;
    defaultMountId?: string;
    defaultFolderId?: string;
    showNewFolder?: boolean;
    hideToolbar?: boolean;
    hideHeader?: boolean;
    createFolderOpen?: boolean;
    onCreateFolderOpenChange?: (open: boolean) => void;
    onSelectionChange?: (items: DrivePath[]) => void;
    ownMountsOnly?: boolean;
    sort?: DriveSortControl;
    className?: string;
};

export function DriveBrowser({
    ownerId,
    mode,
    canPick,
    selectedId,
    onSelect,
    onConfirm,
    onFolderChange,
    defaultMountId = DEFAULT_MOUNT_ID,
    defaultFolderId,
    showNewFolder = mode === 'folder',
    hideToolbar = false,
    hideHeader = false,
    createFolderOpen: controlledCreateFolderOpen,
    onCreateFolderOpenChange,
    onSelectionChange,
    ownMountsOnly,
    sort,
    className,
}: DriveBrowserProps) {
    const [activeMountId, setActiveMountId] = useState(defaultMountId);
    const [activeOwnerId, setActiveOwnerId] = useState(ownerId);
    const [currentFolderId, setCurrentFolderId] = useState<string | null>(defaultFolderId ?? null);
    const [internalCreateFolderOpen, setInternalCreateFolderOpen] = useState(false);
    const createFolderOpen = controlledCreateFolderOpen ?? internalCreateFolderOpen;
    const setCreateFolderOpen = onCreateFolderOpenChange ?? setInternalCreateFolderOpen;

    // The "New folder" menu a right-click on the listing area opens. A right-click on a row opens nothing,
    // since the rows stop it from reaching the listing.
    const newFolderMenu = useContextMenu<true>();

    const prevDefaultFolderIdRef = useRef(defaultFolderId);
    useEffect(() => {
        if (defaultFolderId !== prevDefaultFolderIdRef.current) {
            prevDefaultFolderIdRef.current = defaultFolderId;
            if (defaultFolderId !== undefined) {
                setCurrentFolderId(defaultFolderId);
            }
        }
    }, [defaultFolderId]);

    // A new owner or mount from the parent moves the browser only when it differs from where the browser is: a
    // parent catching up through onFolderChange passes back the mount the user just picked.
    const prevOwnerIdRef = useRef(ownerId);
    useEffect(() => {
        if (ownerId !== prevOwnerIdRef.current) {
            prevOwnerIdRef.current = ownerId;
            if (ownerId && ownerId !== activeOwnerId) {
                setActiveOwnerId(ownerId);
                setCurrentFolderId(null);
            }
        }
    }, [ownerId, activeOwnerId]);

    const prevDefaultMountIdRef = useRef(defaultMountId);
    useEffect(() => {
        if (defaultMountId !== prevDefaultMountIdRef.current) {
            prevDefaultMountIdRef.current = defaultMountId;
            if (defaultMountId !== activeMountId) {
                setActiveMountId(defaultMountId);
                setCurrentFolderId(null);
            }
        }
    }, [defaultMountId, activeMountId]);

    const { data: rootFolder } = useRootFolder(activeOwnerId, activeMountId);
    const mountLabel = useMountLabel(activeOwnerId, activeMountId);
    const folderId = currentFolderId ?? rootFolder?.id ?? '';
    const { data: folderContents = [] } = useFolderContent(activeOwnerId, activeMountId, folderId);
    const { key: sortKey, dir: sortDir } = useDriveSort(sort);
    const sortedContents = useMemo(
        () => [...folderContents].sort(getDriveComparator(sortKey, sortDir)),
        [folderContents, sortKey, sortDir],
    );
    const { data: breadcrumbPaths = [] } = useBreadcrumb(activeOwnerId, activeMountId, folderId);
    const createFolder = useCreateFolder();

    useEffect(() => {
        if (!currentFolderId && rootFolder) {
            setCurrentFolderId(rootFolder.id);
            onFolderChange?.(rootFolder, activeMountId);
        }
    }, [currentFolderId, rootFolder, activeMountId, onFolderChange]);

    const currentPath = breadcrumbPaths.at(-1) ?? null;

    const isPickable = useCallback((item: DrivePath) => canPick?.(item) ?? true, [canPick]);

    const handleMountSelect = useCallback((newOwnerId: string, mountId: string) => {
        setActiveOwnerId(newOwnerId);
        setActiveMountId(mountId);
        setCurrentFolderId(null);
    }, []);

    const navigateToFolder = useCallback(
        (folder: DrivePath) => {
            setCurrentFolderId(folder.id);
            onFolderChange?.(folder, activeMountId);
        },
        [activeMountId, onFolderChange],
    );

    const handleItemClick = useCallback(
        (item: DrivePath) => {
            if (isFolderType(item.type)) {
                navigateToFolder(item);
            } else if (mode === 'file' && isPickable(item)) {
                // With onConfirm and selectedId both set, a click on the row that is already selected confirms
                // it, so the user need not go to the Select button.
                if (onConfirm && selectedId === item.id) {
                    onConfirm(item);
                } else {
                    onSelect?.(item);
                }
            }
        },
        [navigateToFolder, mode, isPickable, onSelect, onConfirm, selectedId],
    );

    const handleCreateFolder = async (folderName: string) => {
        const newFolder = await createFolder.mutateAsync({
            ownerId: activeOwnerId,
            mountId: activeMountId,
            parentId: folderId,
            folderName,
        });
        navigateToFolder(newFolder);
    };

    const isItemDisabled = useCallback(
        (item: DrivePath) => {
            if (mode === 'folder') return !isFolderType(item.type);
            return !isFolderType(item.type) && !isPickable(item);
        },
        [mode, isPickable],
    );

    const contentArea = (
        <div
            className="flex-1 flex flex-col min-w-0"
            onContextMenu={showNewFolder ? (e) => newFolderMenu.handleContextMenu(e, true) : undefined}
        >
            {!hideToolbar && (
                <div className="flex items-center gap-2 h-10 app-gutter-x border-b shrink-0">
                    <DriveBreadcrumb
                        paths={breadcrumbPaths}
                        mountLabel={mountLabel}
                        onNavigate={navigateToFolder}
                        className="flex-1"
                    />
                    {showNewFolder && (
                        <Button variant="ghost" size="sm" onClick={() => setCreateFolderOpen(true)}>
                            <FolderPlus className="h-4 w-4 mr-1" />
                            New folder
                        </Button>
                    )}
                </div>
            )}
            <DriveTable
                items={sortedContents}
                activeItemId={selectedId ?? undefined}
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
    );

    return (
        <div className={cn('flex h-full', className)}>
            <div className="hidden sm:block w-44 border-r p-2 overflow-y-auto shrink-0">
                <DriveMountList
                    activeMountId={activeMountId}
                    activeOwnerId={activeOwnerId}
                    onMountSelect={handleMountSelect}
                    ownMountsOnly={ownMountsOnly}
                />
            </div>
            {contentArea}
            {showNewFolder && (
                <ContextMenuAnchor contextMenu={newFolderMenu} className="min-w-48">
                    <DropdownMenuItem
                        onClick={() => {
                            setCreateFolderOpen(true);
                            newFolderMenu.close();
                        }}
                    >
                        <FolderPlus className="h-4 w-4" />
                        New folder
                    </DropdownMenuItem>
                </ContextMenuAnchor>
            )}
            {showNewFolder && currentPath && (
                <DriveItemNameDialog
                    open={createFolderOpen}
                    onOpenChange={setCreateFolderOpen}
                    onSave={handleCreateFolder}
                    type="Folder"
                    path={currentPath}
                />
            )}
        </div>
    );
}
