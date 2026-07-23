import {
    defaultDriveSort,
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
import { DriveCreateItemDialog } from './drive-create-folder-item';
import { DriveMountList, useMountLabel } from './drive-mount-list';
import { DriveTable } from './drive-table';

function matchesMimeFilter(mimeType: string, filters: string[]): boolean {
    return filters.some((filter) => {
        if (filter.endsWith('/*')) return mimeType.startsWith(filter.slice(0, -1));
        return mimeType === filter;
    });
}

type DriveBrowserProps = {
    ownerId: string;
    mode: 'file' | 'folder';
    mimeFilter?: string[];
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
    externalSelectedIds?: Set<string>;
    onSelectionChange?: (items: DrivePath[]) => void;
    ownMountsOnly?: boolean;
    className?: string;
};

export function DriveBrowser({
    ownerId,
    mode,
    mimeFilter,
    selectedId,
    onSelect,
    onConfirm,
    onFolderChange,
    defaultMountId = 'default',
    defaultFolderId,
    showNewFolder = mode === 'folder',
    hideToolbar = false,
    hideHeader = false,
    createFolderOpen: controlledCreateFolderOpen,
    onCreateFolderOpenChange,
    externalSelectedIds,
    onSelectionChange,
    ownMountsOnly,
    className,
}: DriveBrowserProps) {
    const [activeMountId, setActiveMountId] = useState(defaultMountId);
    const [activeOwnerId, setActiveOwnerId] = useState(ownerId);
    const [currentFolderId, setCurrentFolderId] = useState<string | null>(defaultFolderId ?? null);
    const [internalCreateFolderOpen, setInternalCreateFolderOpen] = useState(false);
    const createFolderOpen = controlledCreateFolderOpen ?? internalCreateFolderOpen;
    const setCreateFolderOpen = onCreateFolderOpenChange ?? setInternalCreateFolderOpen;

    // Background "New folder" menu, opened by right-clicking the listing area (rows
    // stop propagation, so their right-clicks surface the per-item menu instead).
    const newFolderMenu = useContextMenu<true>();

    const prevDefaultFolderId = useRef(defaultFolderId);
    useEffect(() => {
        if (defaultFolderId !== prevDefaultFolderId.current) {
            prevDefaultFolderId.current = defaultFolderId;
            if (defaultFolderId !== undefined) {
                setCurrentFolderId(defaultFolderId);
            }
        }
    }, [defaultFolderId]);

    // Sync external owner/mount changes into local state — but only when the prop truly
    // disagrees with internal state. When the parent re-renders with props that match our
    // own handleMountSelect result (the parent catching up via onFolderChange), we skip to
    // avoid bouncing the user's in-progress navigation back to the mount root.
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
    const sortedContents = useMemo(() => [...folderContents].sort(defaultDriveSort), [folderContents]);
    const { data: breadcrumbPaths = [] } = useBreadcrumb(activeOwnerId, activeMountId, folderId);
    const createFolder = useCreateFolder(activeOwnerId, activeMountId);

    useEffect(() => {
        if (!currentFolderId && rootFolder) {
            setCurrentFolderId(rootFolder.id);
            onFolderChange?.(rootFolder, activeMountId);
        }
    }, [currentFolderId, rootFolder, activeMountId, onFolderChange]);

    const currentPath = breadcrumbPaths[breadcrumbPaths.length - 1] ?? null;

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
                if (mode === 'folder') {
                    onSelect?.(item);
                }
            } else if (mode === 'file') {
                if (!mimeFilter || matchesMimeFilter(item.mimeType, mimeFilter)) {
                    // Single-select mode (onConfirm + selectedId both set): clicking the
                    // already-selected row confirms it, saving an extra trip to the Select button.
                    if (onConfirm && selectedId === item.id) {
                        onConfirm(item);
                    } else {
                        onSelect?.(item);
                    }
                }
            }
        },
        [navigateToFolder, mode, mimeFilter, onSelect, onConfirm, selectedId],
    );

    const handleItemOpen = useCallback(
        (item: DrivePath) => {
            if (isFolderType(item.type)) {
                navigateToFolder(item);
            } else if (mode === 'file' && onConfirm) {
                if (!mimeFilter || matchesMimeFilter(item.mimeType, mimeFilter)) {
                    onConfirm(item);
                }
            }
        },
        [navigateToFolder, mode, mimeFilter, onConfirm],
    );

    const handleBreadcrumbClick = (path: DrivePath) => {
        setCurrentFolderId(path.id);
        onFolderChange?.(path, activeMountId);
    };

    const handleCreateFolder = (folderName: string) => {
        createFolder.mutate(
            { parentId: folderId, folderName },
            {
                onSuccess: (newFolder) => {
                    setCreateFolderOpen(false);
                    if (newFolder) {
                        navigateToFolder(newFolder);
                        if (mode === 'folder') {
                            onSelect?.(newFolder);
                        }
                    }
                },
            },
        );
    };

    const isItemDisabled = useCallback(
        (item: DrivePath) => {
            if (mode === 'folder') return !isFolderType(item.type);
            if (mode === 'file' && mimeFilter)
                return !isFolderType(item.type) && !matchesMimeFilter(item.mimeType, mimeFilter);
            return false;
        },
        [mode, mimeFilter],
    );

    const contentArea = (
        <div
            className="flex-1 flex flex-col min-w-0"
            onContextMenu={showNewFolder ? (e) => newFolderMenu.handleContextMenu(e, true) : undefined}
        >
            {!hideToolbar && (
                <div className="flex items-center gap-2 h-10 px-3 border-b shrink-0">
                    <DriveBreadcrumb
                        paths={breadcrumbPaths}
                        mountLabel={mountLabel}
                        onNavigate={handleBreadcrumbClick}
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
                onItemOpen={handleItemOpen}
                isItemDisabled={isItemDisabled}
                hideModified
                hideOwner
                hideShareClick
                hideHeader={hideHeader}
                externalSelectedIds={externalSelectedIds}
                onSelectionChange={onSelectionChange}
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
                        <FolderPlus className="h-4 w-4 mr-2" />
                        New folder
                    </DropdownMenuItem>
                </ContextMenuAnchor>
            )}
            {showNewFolder && currentPath && (
                <DriveCreateItemDialog
                    open={createFolderOpen}
                    onOpenChange={setCreateFolderOpen}
                    onCreateItem={handleCreateFolder}
                    isPending={createFolder.isPending}
                    type="Folder"
                    path={currentPath}
                />
            )}
        </div>
    );
}
