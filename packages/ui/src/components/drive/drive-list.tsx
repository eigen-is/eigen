// The list column of a Drive view: DriveList draws the rows as a table or a grid with selection, drop
// and context menus, and hands the selection to the command palette. DriveListToolbar draws the crumb
// row or title above it with the view controls. DriveLayout mounts both, for example in Drive's folder
// view and in the document apps' lists.

import { useBreadcrumb, useDriveViewPreferences } from '@workspace/lib/drive';
import { useIsMobile } from '@workspace/lib/media';
import type { PaletteSelectionAction } from '@workspace/lib/types/command-palette';
import type { DrivePath, DriveViewMode } from '@workspace/lib/types/drive';
import { DRIVE_SORT_KEYS } from '@workspace/lib/types/drive';
import { Button } from '@workspace/ui/components/button';
import {
    ChoiceMenuItems,
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuLabel,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
} from '@workspace/ui/components/dropdown-menu';
import { KebabTrigger, ToolbarTitle } from '@workspace/ui/components/layout/toolbar';
import { ToggleGroup, ToggleGroupItem } from '@workspace/ui/components/toggle-group';
import { ArrowDown, ArrowUp, ChevronDown, LayoutGrid, List, Plus, UploadIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { useFileDropTarget } from '../../hooks/use-file-drop-target';
import { useListSelection } from '../../hooks/use-list-selection';
import { ContextMenuAnchor, useContextMenu } from '../context-menu';
import { FileDropOverlay } from '../file-drop-overlay';
import { EmptyState } from '../layout/app/empty-state';
import { ErrorState } from '../layout/app/error-state';
import { useLayout } from '../layout/app/layout-context';
import type { CreateCallbacks } from './create-menu';
import { getCreateMenuItems } from './create-menu';
import type { DriveActionRunner } from './drive-action-runner';
import { DriveBreadcrumb } from './drive-breadcrumb';
import { DriveGrid } from './drive-grid';
import { useMountLabel } from './drive-mount-list';
import { DrivePaletteSelection } from './drive-palette-selection';
import type { DriveListDate, DriveSortControl } from './drive-table';
import { DriveTable, driveSortLabel, useDriveSort } from './drive-table';

const VIEW_MODES: { value: DriveViewMode; label: ReactNode }[] = [
    {
        value: 'list',
        label: (
            <>
                <List /> List
            </>
        ),
    },
    {
        value: 'grid',
        label: (
            <>
                <LayoutGrid /> Grid
            </>
        ),
    },
];

type DriveViewControlsProps = { sort?: DriveSortControl; dateLabel?: string };

function SortMenuItems({ sort, dateLabel }: DriveViewControlsProps) {
    const { key: sortKey, dir: sortDir, choose } = useDriveSort(sort);

    return (
        <ChoiceMenuItems
            value={sortKey}
            options={DRIVE_SORT_KEYS.map((key) => ({
                value: key,
                label: (
                    <>
                        {driveSortLabel(key, dateLabel)}
                        {key === sortKey &&
                            (sortDir === 'asc' ? (
                                <ArrowUp className="h-4 w-4 ml-auto" />
                            ) : (
                                <ArrowDown className="h-4 w-4 ml-auto" />
                            ))}
                    </>
                ),
            }))}
            onChange={choose}
        />
    );
}

// The sort menu and the list or grid switch. The layout always follows the shared view preference, and the
// sort does unless the listing keeps its own.
export function DriveViewControls({ sort, dateLabel }: DriveViewControlsProps) {
    const isMobile = useIsMobile();
    const { mode, setMode } = useDriveViewPreferences();
    const { key: sortKey } = useDriveSort(sort);

    if (isMobile) {
        return (
            <DropdownMenu>
                <KebabTrigger title="View options" />
                <DropdownMenuContent align="end">
                    <DropdownMenuLabel>Sort by</DropdownMenuLabel>
                    <SortMenuItems sort={sort} dateLabel={dateLabel} />
                    <DropdownMenuSeparator />
                    <ChoiceMenuItems value={mode} options={VIEW_MODES} onChange={setMode} />
                </DropdownMenuContent>
            </DropdownMenu>
        );
    }

    return (
        <>
            {/* The grid has no column headers to sort by, so only it gets a sort menu. */}
            {mode === 'grid' && (
                <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                        <Button variant="outline" size="sm">
                            {driveSortLabel(sortKey, dateLabel)}
                            <ChevronDown className="h-4 w-4 ml-1" />
                        </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                        <SortMenuItems sort={sort} dateLabel={dateLabel} />
                    </DropdownMenuContent>
                </DropdownMenu>
            )}
            <ToggleGroup
                type="single"
                variant="outline"
                size="sm"
                value={mode}
                onValueChange={(value) => {
                    const picked = VIEW_MODES.find((option) => option.value === value);
                    if (picked) setMode(picked.value);
                }}
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
    // Set by an app that has a Shared with me page; without it the crumb is plain text.
    onOpenSharedWithMe?: () => void;
} & DriveViewControlsProps;

export function DriveListToolbar({
    ownerId,
    mountId,
    pathId,
    showBreadcrumb = true,
    title,
    onRowActivate,
    onOpenSharedWithMe,
    onCreateFolder,
    onUploadFile,
    onCreateEigenDoc,
    sort,
    dateLabel,
}: DriveListToolbarProps) {
    const { data: breadcrumbPaths = [] } = useBreadcrumb(ownerId, mountId, showBreadcrumb ? pathId : undefined);
    const mountLabel = useMountLabel(ownerId, mountId);
    const { isMobile } = useLayout();

    const createItems = getCreateMenuItems({ onCreateFolder, onUploadFile, onCreateEigenDoc });

    // Icon only: the button shows on a phone only, where the row has to fit a 390px screen beside the
    // back arrow.
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
                            <Icon className="h-4 w-4" />
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
                    onNavigate={(path) => onRowActivate?.(path)}
                    onOpenSharedWithMe={onOpenSharedWithMe}
                    itemClassName="flex items-center"
                />
            ) : title ? (
                <ToolbarTitle>{title}</ToolbarTitle>
            ) : (
                <div className="flex-1" />
            )}
            <div className="flex items-center gap-1">
                <DriveViewControls sort={sort} dateLabel={dateLabel} />
                {isMobile && newItemButton}
            </div>
        </div>
    );
}

type DriveListProps = CreateCallbacks & {
    // Already sorted by the caller: the list draws them and selects ranges in this order.
    items: DrivePath[];
    error?: Error | null;
    onRowSelect?: (path: DrivePath) => void;
    onRowActivate?: (path: DrivePath) => void;
    activeRowId?: string;
    onUploadFiles?: (files: File[]) => void;
    getItemHref?: (item: DrivePath) => string | undefined;
    ownerId: string;
    mountId: string;
    pathId?: string;
    allowUpload?: boolean;
    // What the rows' menus, keys and drops do. Absent in a listing with actions of its own.
    actions?: DriveActionRunner;
    onQuickLook?: (path: DrivePath) => void;
    unreadPathIds?: ReadonlySet<string>;
    hideShared?: boolean;
    date?: DriveListDate;
    // The rows of a listing with actions of its own, such as Trash, for the items they act on: the
    // rows' menu draws them and the command palette offers them.
    ownActions?: (items: readonly DrivePath[]) => PaletteSelectionAction[];
    sort?: DriveSortControl;
};

export function DriveList({
    items,
    error = null,
    onRowSelect,
    onRowActivate,
    activeRowId,
    onCreateFolder,
    onUploadFile,
    onUploadFiles,
    onCreateEigenDoc,
    getItemHref,
    ownerId,
    mountId,
    pathId,
    allowUpload = false,
    actions,
    onQuickLook,
    unreadPathIds,
    hideShared,
    date,
    ownActions,
    sort,
}: DriveListProps) {
    const { data: breadcrumbPaths } = useBreadcrumb(ownerId, mountId, pathId);
    const { mode } = useDriveViewPreferences();

    // The selection lives here rather than in each view, so it survives a switch between list and grid.
    const selection = useListSelection({ items, getId: (item: DrivePath) => item.id });

    // The create menu a right-click on the listing area opens. A right-click on a row opens the row's menu
    // instead, since the rows stop it from reaching the listing.
    const createMenu = useContextMenu<true>();

    const handleRowClick = (path: DrivePath) => {
        if (path.id === activeRowId && onRowActivate) {
            onRowActivate(path);
        } else if (onRowSelect) {
            onRowSelect(path);
        }
    };

    const dropWorks = allowUpload && !!onUploadFiles;
    const { targetProps, isDragging } = useFileDropTarget((files) => onUploadFiles?.(files), dropWorks);

    const createItems = getCreateMenuItems({ onCreateFolder, onUploadFile, onCreateEigenDoc });

    if (error) {
        return <ErrorState />;
    }

    const sharedProps = {
        items,
        activeItemId: activeRowId,
        onItemClick: handleRowClick,
        getItemHref,
        actions,
        selection,
        ownActions,
        onQuickLook,
        unreadPathIds,
    };

    // The empty listing's hint names a drop only where a drop uploads, and the New button only where
    // there is something to create, by the label it has where it creates one kind only.
    const newLabel = createItems.length === 1 ? createItems[0].buttonLabel : 'New';
    const emptyHint = dropWorks
        ? createItems.length > 0
            ? `Drop files here, or use the “${newLabel}” button.`
            : 'Drop files here.'
        : createItems.length > 0
          ? `Use the “${newLabel}” button to create one.`
          : undefined;

    const contentDiv = (
        <div
            className="h-full flex flex-col relative border-r"
            {...targetProps}
            onContextMenu={createItems.length > 0 ? (e) => createMenu.handleContextMenu(e, true) : undefined}
        >
            {allowUpload && <FileDropOverlay visible={isDragging} label="Drop files to upload" icon={UploadIcon} />}

            {/* In place of the table, so the empty state centers in the whole list area. */}
            {items.length === 0 ? (
                <EmptyState hint={emptyHint} />
            ) : mode === 'grid' ? (
                <DriveGrid {...sharedProps} />
            ) : (
                <DriveTable
                    {...sharedProps}
                    hideShared={hideShared}
                    date={date}
                    ancestorBreadcrumb={breadcrumbPaths ?? []}
                    sort={sort}
                />
            )}
            <DrivePaletteSelection
                items={selection.selectedItems}
                listing={items}
                actions={actions}
                ownActions={ownActions}
            />
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
                        <Icon className="h-4 w-4" />
                        {label}
                    </DropdownMenuItem>
                ))}
            </ContextMenuAnchor>
        </>
    );
}
