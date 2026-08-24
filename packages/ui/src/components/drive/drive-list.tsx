import { usePaletteSelection } from '@workspace/lib/command-palette';
import { useBreadcrumb, useDriveViewPreferences } from '@workspace/lib/drive';
import { useIsMobile } from '@workspace/lib/media';
import type { DrivePath, DriveSortKey, DriveViewMode } from '@workspace/lib/types/drive';
import { Button } from '@workspace/ui/components/button';
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuLabel,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
} from '@workspace/ui/components/dropdown-menu';
import { KebabTrigger, ToolbarTitle } from '@workspace/ui/components/layout/toolbar';
import { ToggleGroup, ToggleGroupItem } from '@workspace/ui/components/toggle-group';
import { ArrowDown, ArrowUp, Check, ChevronDown, LayoutGrid, List, Plus, UploadIcon } from 'lucide-react';
import type React from 'react';
import { useMemo } from 'react';
import { useFileDropTarget } from '../../hooks/use-file-drop-target';
import { useListSelection } from '../../hooks/use-list-selection';
import { ContextMenuAnchor, useContextMenu } from '../context-menu';
import { FileDropOverlay } from '../file-drop-overlay';
import { EmptyState } from '../layout/app/empty-state';
import { ErrorState } from '../layout/app/error-state';
import { useLayout } from '../layout/app/layout-context';
import { LoadingState } from '../layout/app/loading-state';
import { type CreateCallbacks, getCreateMenuItems } from './create-menu';
import { DriveBreadcrumb } from './drive-breadcrumb';
import { DriveGrid } from './drive-grid';
import { useMountLabel } from './drive-mount-list';
import { DriveTable, nextDriveSort } from './drive-table';

const SORT_LABELS: Record<DriveSortKey, string> = { name: 'Name', modified: 'Modified', size: 'Size' };

// The three sort options, shared by the grid-mode sort dropdown and the mobile kebab. List mode
// sorts via the table's column headers instead. Re-selecting the active field flips direction;
// switching field uses that field's default (see nextDriveSort in drive-table).
function SortMenuItems() {
    const { sortKey, sortDir, setSort } = useDriveViewPreferences();
    const chooseSort = (key: DriveSortKey) => setSort(key, nextDriveSort(key, sortKey, sortDir));

    return (
        <>
            {(Object.keys(SORT_LABELS) as DriveSortKey[]).map((key) => (
                <DropdownMenuItem key={key} onClick={() => chooseSort(key)}>
                    {SORT_LABELS[key]}
                    {key === sortKey &&
                        (sortDir === 'asc' ? (
                            <ArrowUp className="h-4 w-4 ml-auto" />
                        ) : (
                            <ArrowDown className="h-4 w-4 ml-auto" />
                        ))}
                </DropdownMenuItem>
            ))}
        </>
    );
}

// Sort dropdown + list/grid toggle bound to the shared view preference.
// Lives in every drive listing toolbar (browser, filter views, trash).
// Mobile collapses both controls into a single kebab.
export function DriveViewControls() {
    const isMobile = useIsMobile();
    const { mode, setMode, sortKey } = useDriveViewPreferences();

    if (isMobile) {
        return (
            <DropdownMenu>
                <KebabTrigger title="View options" />
                <DropdownMenuContent align="end">
                    <DropdownMenuLabel>Sort by</DropdownMenuLabel>
                    <SortMenuItems />
                    <DropdownMenuSeparator />
                    <DropdownMenuItem onClick={() => setMode('list')}>
                        <List className="mr-2" />
                        List
                        {mode === 'list' && <Check className="h-4 w-4 ml-auto" />}
                    </DropdownMenuItem>
                    <DropdownMenuItem onClick={() => setMode('grid')}>
                        <LayoutGrid className="mr-2" />
                        Grid
                        {mode === 'grid' && <Check className="h-4 w-4 ml-auto" />}
                    </DropdownMenuItem>
                </DropdownMenuContent>
            </DropdownMenu>
        );
    }

    return (
        <>
            {/* List mode sorts via column headers; only grid mode (no headers) keeps a sort dropdown. */}
            {mode === 'grid' && (
                <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                        <Button variant="outline" size="sm">
                            {SORT_LABELS[sortKey]}
                            <ChevronDown className="h-4 w-4 ml-1" />
                        </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                        <SortMenuItems />
                    </DropdownMenuContent>
                </DropdownMenu>
            )}
            <ToggleGroup
                type="single"
                variant="outline"
                size="sm"
                value={mode}
                onValueChange={(v) => v && setMode(v as DriveViewMode)}
            >
                <ToggleGroupItem value="list" aria-label="List view">
                    <List className="h-4 w-4" />
                </ToggleGroupItem>
                <ToggleGroupItem value="grid" aria-label="Grid view">
                    <LayoutGrid className="h-4 w-4" />
                </ToggleGroupItem>
            </ToggleGroup>
        </>
    );
}

type DriveListToolbarProps = CreateCallbacks & {
    ownerId: string;
    mountId: string;
    pathId?: string;
    showBreadcrumb?: boolean;
    title?: string;
    onRowActivate?: (path: DrivePath) => void;
};

export function DriveListToolbar({
    ownerId,
    mountId,
    pathId,
    showBreadcrumb = true,
    title,
    onRowActivate,
    onCreateFolder,
    onUploadFile,
    onCreateEigenDoc,
}: DriveListToolbarProps) {
    const { data: breadcrumbPaths = [] } = useBreadcrumb(ownerId, mountId, showBreadcrumb ? pathId : undefined);
    const mountLabel = useMountLabel(ownerId, mountId);
    const { isMobile } = useLayout();

    const handleBreadcrumbClick = (path: DrivePath) => {
        onRowActivate?.(path);
    };

    const createItems = getCreateMenuItems({ onCreateFolder, onUploadFile, onCreateEigenDoc });

    // Icon-only: this button renders on mobile only, and the row must fit a 390px
    // viewport beside the back arrow.
    const newItemButton =
        createItems.length === 0 ? null : createItems.length === 1 ? (
            <Button size="icon" aria-label={createItems[0].buttonLabel} onClick={createItems[0].onSelect}>
                <Plus />
            </Button>
        ) : (
            <DropdownMenu>
                <DropdownMenuTrigger asChild>
                    <Button size="icon" aria-label="New">
                        <Plus />
                    </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                    {createItems.map(({ kind, icon: Icon, label, onSelect }) => (
                        <DropdownMenuItem key={kind} onClick={onSelect}>
                            <Icon className="h-4 w-4 mr-2" />
                            {label}
                        </DropdownMenuItem>
                    ))}
                </DropdownMenuContent>
            </DropdownMenu>
        );

    return (
        <div className="flex items-center justify-between w-full">
            {showBreadcrumb ? (
                <DriveBreadcrumb
                    paths={breadcrumbPaths}
                    mountLabel={mountLabel}
                    onNavigate={handleBreadcrumbClick}
                    itemClassName="flex items-center"
                />
            ) : title ? (
                <ToolbarTitle>{title}</ToolbarTitle>
            ) : (
                <div className="flex-1" />
            )}
            <div className="flex items-center gap-1">
                <DriveViewControls />
                {isMobile && newItemButton}
            </div>
        </div>
    );
}

type DriveListProps = CreateCallbacks & {
    // Already sorted by the caller — rendered and range-selected in this order.
    items: DrivePath[];
    isLoading?: boolean;
    error?: Error | null;
    onRowSelect?: (path: DrivePath) => void;
    onRowActivate?: (path: DrivePath) => void;
    activeRowId?: string;
    onUploadFiles?: (files: File[]) => void;
    onDelete?: (paths: DrivePath[]) => void;
    onShareClick?: (item: DrivePath) => void;
    onEmailCollaborators?: (item: DrivePath) => void;
    onConvert?: (item: DrivePath, targetType: 'eigensheets' | 'eigendoc') => void;
    onDownload?: (path: DrivePath) => void;
    onExport?: (item: DrivePath, format: string) => void;
    getItemHref?: (item: DrivePath) => string | undefined;
    ownerId: string;
    mountId: string;
    pathId?: string;
    allowDelete?: boolean;
    allowUpload?: boolean;
    onRename?: (item: DrivePath) => void;
    onMove?: (item: DrivePath, targetItemId: string) => void;
    onMoveTo?: (items: DrivePath[]) => void;
    onCopyTo?: (items: DrivePath[]) => void;
    onDuplicate?: (items: DrivePath[]) => void;
    onQuickLook?: (path: DrivePath) => void;
    unreadPathIds?: Set<string>;
    hideOwner?: boolean;
    hideShared?: boolean;
    dateLabel?: string;
    getItemDate?: (item: DrivePath) => Date | null;
    contextMenuItems?: (items: DrivePath[], close: () => void) => React.ReactNode;
    emptyState?: React.ReactNode;
};

export function DriveList({
    items = [],
    isLoading = false,
    error = null,
    onRowSelect,
    onRowActivate,
    activeRowId,
    onCreateFolder,
    onUploadFile,
    onUploadFiles,
    onDelete,
    onShareClick,
    onEmailCollaborators,
    onCreateEigenDoc,
    onConvert,
    onDownload,
    onExport,
    getItemHref,
    ownerId,
    mountId,
    pathId,
    allowDelete = false,
    allowUpload = false,
    onRename,
    onMove,
    onMoveTo,
    onCopyTo,
    onDuplicate,
    onQuickLook,
    unreadPathIds,
    hideOwner,
    hideShared,
    dateLabel,
    getItemDate,
    contextMenuItems,
    emptyState,
}: DriveListProps) {
    const { data: breadcrumbPaths } = useBreadcrumb(ownerId, mountId, pathId);
    const { mode } = useDriveViewPreferences();

    // Selection lives here (not per view) so it survives list/grid toggles.
    const selection = useListSelection({ items, getId: (item: DrivePath) => item.id });

    // Publish the multi-selection to the command palette. Memoized so the wrapper's
    // identity stays stable across re-renders that don't change the selection.
    const paletteSelection = useMemo(
        () => (selection.selectedItems.length > 0 ? { items: selection.selectedItems } : null),
        [selection.selectedItems],
    );
    usePaletteSelection(paletteSelection);

    // Background create menu, opened by right-clicking the empty listing area (rows
    // stop propagation, so their right-clicks surface the per-item menu instead).
    const createMenu = useContextMenu<true>();

    // Handle row click with two different behaviors
    const handleRowClick = (path: DrivePath) => {
        if (path.id === activeRowId && onRowActivate) {
            // If the item is already selected, activate it
            onRowActivate(path);
        } else if (onRowSelect) {
            // Otherwise select it
            onRowSelect(path);
        }
    };

    const { targetProps, isDragging } = useFileDropTarget(
        (files) => onUploadFiles?.(files),
        allowUpload && !!onUploadFiles,
    );

    const createItems = getCreateMenuItems({ onCreateFolder, onUploadFile, onCreateEigenDoc });

    if (isLoading) {
        return <LoadingState />;
    }

    if (error) {
        return <ErrorState message="Error loading files" detail={error.message} />;
    }

    // Shared inputs for both views; the table additionally gets the column config.
    const sharedProps = {
        items,
        activeItemId: activeRowId,
        onItemClick: handleRowClick,
        onItemOpen: onRowActivate,
        onShareClick,
        onEmailCollaborators,
        getItemHref,
        onConvert,
        onDownload,
        onExport,
        onDelete,
        allowDelete,
        onRename,
        onMove,
        onMoveTo,
        onCopyTo,
        onDuplicate,
        selection,
        contextMenuItems,
        onQuickLook,
        unreadPathIds,
    };

    // Context-aware default empty-state hint: only mention drag-drop where it works,
    // and point at the "New" button only when there's something to create.
    const dropWorks = allowUpload && !!onUploadFiles;
    const defaultEmptyHint = dropWorks
        ? createItems.length > 0
            ? 'Drop files here, or use the “New” button.'
            : 'Drop files here.'
        : createItems.length > 0
          ? 'Use the “New” button to create one.'
          : undefined;

    const contentDiv = (
        <div
            className="h-full flex flex-col relative border-r"
            {...targetProps}
            onContextMenu={createItems.length > 0 ? (e) => createMenu.handleContextMenu(e, true) : undefined}
        >
            {allowUpload && <FileDropOverlay visible={isDragging} label="Drop files to upload" icon={UploadIcon} />}

            {mode === 'grid' ? (
                <DriveGrid {...sharedProps} />
            ) : (
                <DriveTable
                    {...sharedProps}
                    hideOwner={hideOwner}
                    hideShared={hideShared}
                    dateLabel={dateLabel}
                    getItemDate={getItemDate}
                    ancestorBreadcrumb={breadcrumbPaths ?? []}
                />
            )}

            {items.length === 0 && (emptyState ?? <EmptyState hint={defaultEmptyHint} />)}
        </div>
    );

    if (createItems.length === 0) return contentDiv;

    return (
        <>
            {contentDiv}
            <ContextMenuAnchor contextMenu={createMenu} className="min-w-48">
                {createItems.map(({ kind, icon: Icon, label, onSelect }) => (
                    <DropdownMenuItem
                        key={kind}
                        onClick={() => {
                            onSelect();
                            createMenu.close();
                        }}
                    >
                        <Icon className="h-4 w-4 mr-2" />
                        {label}
                    </DropdownMenuItem>
                ))}
            </ContextMenuAnchor>
        </>
    );
}
