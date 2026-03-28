import { useBreadcrumb } from '@workspace/lib/drive';
import type { DrivePath } from '@workspace/lib/types/drive';
import {
    Breadcrumb,
    BreadcrumbItem,
    BreadcrumbLink,
    BreadcrumbList,
    BreadcrumbPage,
    BreadcrumbSeparator,
} from '@workspace/ui/components/breadcrumb';
import { Button } from '@workspace/ui/components/button';
import {
    ContextMenu,
    ContextMenuContent,
    ContextMenuItem,
    ContextMenuTrigger,
} from '@workspace/ui/components/context-menu';
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuTrigger,
} from '@workspace/ui/components/dropdown-menu';
import { DriveTable, getFileIcon } from '@workspace/ui/components/layout/drive';
import { cn } from '@workspace/ui/lib/utils';
import { FileText, FolderPlus, MessageSquare, Plus, Presentation, Sheet, StickyNote, UploadIcon } from 'lucide-react';
import { Fragment, useRef, useState } from 'react';
import { EmptyState } from '../app/empty-state';
import { ErrorState } from '../app/error-state';
import { useLayout } from '../app/layout-context.tsx';
import { LoadingState } from '../app/loading-state';

type CreateCallbacks = {
    onCreateFolder?: () => void;
    onUploadFile?: () => void;
    onCreateDoc?: () => void;
    onCreateStickies?: () => void;
    onCreateChat?: () => void;
    onCreateSlides?: () => void;
    onCreateSheets?: () => void;
};

const CREATE_MENU_DEFS: { key: keyof CreateCallbacks; icon: typeof FolderPlus; label: string; buttonLabel: string }[] =
    [
        { key: 'onCreateFolder', icon: FolderPlus, label: 'Create folder', buttonLabel: 'New folder' },
        { key: 'onUploadFile', icon: UploadIcon, label: 'Upload file', buttonLabel: 'Upload' },
        { key: 'onCreateDoc', icon: FileText, label: 'Create document', buttonLabel: 'New document' },
        { key: 'onCreateStickies', icon: StickyNote, label: 'Create stickies', buttonLabel: 'New stickies' },
        { key: 'onCreateChat', icon: MessageSquare, label: 'Create chat', buttonLabel: 'New chat' },
        { key: 'onCreateSlides', icon: Presentation, label: 'Create slides', buttonLabel: 'New slides' },
        { key: 'onCreateSheets', icon: Sheet, label: 'Create sheets', buttonLabel: 'New sheets' },
    ];

function getCreateMenuItems(cb: CreateCallbacks) {
    return CREATE_MENU_DEFS.filter((def) => cb[def.key]).map((def) => ({ ...def, onSelect: cb[def.key]! }));
}

type DriveListToolbarProps = CreateCallbacks & {
    ownerId: string;
    mountId: string;
    pathId: string;
    showBreadcrumb?: boolean;
    onRowSelect?: (path: DrivePath) => void;
    onRowActivate?: (path: DrivePath) => void;
    activeRowId?: string;
};

export function DriveListToolbar({
    ownerId,
    mountId,
    pathId,
    showBreadcrumb = true,
    onRowSelect,
    onRowActivate,
    activeRowId,
    onCreateFolder,
    onUploadFile,
    onCreateDoc,
    onCreateStickies,
    onCreateChat,
    onCreateSlides,
    onCreateSheets,
}: DriveListToolbarProps) {
    const { data: breadcrumbPaths = [] } = useBreadcrumb(ownerId, mountId, showBreadcrumb ? pathId : undefined);
    const { isMobile } = useLayout();

    const handleBreadcrumbClick = (path: DrivePath) => {
        if (path.id === activeRowId && onRowActivate) {
            onRowActivate(path);
        } else if (onRowSelect) {
            onRowSelect(path);
        }
    };

    const createItems = getCreateMenuItems({
        onCreateFolder,
        onUploadFile,
        onCreateDoc,
        onCreateStickies,
        onCreateChat,
        onCreateSlides,
        onCreateSheets,
    });

    const newItemButton =
        createItems.length === 0 ? null : createItems.length === 1 ? (
            <Button size="default" onClick={createItems[0].onSelect}>
                <Plus />
                <span className="mr-2">{createItems[0].buttonLabel}</span>
            </Button>
        ) : (
            <DropdownMenu>
                <DropdownMenuTrigger asChild>
                    <Button size="default">
                        <Plus />
                        <span className="mr-2">New</span>
                    </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                    {createItems.map(({ key, icon: Icon, label, onSelect }) => (
                        <DropdownMenuItem key={key} onClick={onSelect}>
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
                <Breadcrumb className="overflow-hidden">
                    <BreadcrumbList>
                        {breadcrumbPaths.map((path, index) => (
                            <Fragment key={path.id}>
                                {index > 0 && <BreadcrumbSeparator />}
                                <BreadcrumbItem>
                                    {index === breadcrumbPaths.length - 1 ? (
                                        <BreadcrumbPage className="flex items-center">{path.name}</BreadcrumbPage>
                                    ) : (
                                        <BreadcrumbLink
                                            onClick={() => handleBreadcrumbClick(path)}
                                            className="flex items-center cursor-pointer"
                                        >
                                            {path.name}
                                        </BreadcrumbLink>
                                    )}
                                </BreadcrumbItem>
                            </Fragment>
                        ))}
                    </BreadcrumbList>
                </Breadcrumb>
            ) : (
                <div className="flex-1" />
            )}
            <div className="flex gap-1">{isMobile && newItemButton}</div>
        </div>
    );
}

type DriveListProps = CreateCallbacks & {
    items: DrivePath[];
    isLoading?: boolean;
    error?: Error | null;
    onRowSelect?: (path: DrivePath) => void;
    onRowActivate?: (path: DrivePath) => void;
    activeRowId?: string;
    onUploadFiles?: (files: File[]) => void;
    currentPath?: DrivePath | null;
    onDelete?: (paths: DrivePath[]) => void;
    onShareClick?: (item: DrivePath) => void;
    onDownload?: (path: DrivePath) => void;
    ownerId: string;
    mountId: string;
    pathId: string;
    showBreadcrumb?: boolean;
    allowDelete?: boolean;
    allowDownload?: boolean;
    allowUpload?: boolean;
    onRename?: (item: DrivePath) => void;
    onMove?: (item: DrivePath, targetItemId: string) => void;
    onQuickLook?: (path: DrivePath) => void;
    sortFn?: (a: DrivePath, b: DrivePath) => number;
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
    currentPath,
    onShareClick,
    onCreateDoc,
    onCreateStickies,
    onCreateChat,
    onCreateSlides,
    onCreateSheets,
    onDownload,
    ownerId,
    mountId,
    pathId,
    allowDelete = false,
    allowDownload = false,
    allowUpload = false,
    onRename,
    onMove,
    onQuickLook,
    sortFn,
}: DriveListProps) {
    const { data: breadcrumbPaths } = useBreadcrumb(ownerId, mountId, pathId);
    const [isDragging, setIsDragging] = useState(false);
    const dragCounter = useRef(0);
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

    const isValidDataTransfer = (data: DataTransfer) => data.types.includes('Files');

    // Drag and drop handlers
    const handleDragOver = (e: React.DragEvent<HTMLDivElement>) => {
        // Only handle external file drops, not internal drag operations
        if (isValidDataTransfer(e.dataTransfer)) {
            e.preventDefault(); // Necessary to allow drops
            e.stopPropagation();
        }
    };

    const handleDragEnter = (e: React.DragEvent<HTMLDivElement>) => {
        // Only handle external file drops, not internal drag operations
        if (isValidDataTransfer(e.dataTransfer)) {
            e.preventDefault();
            e.stopPropagation();

            // Increment counter when entering any element
            dragCounter.current += 1;

            // Only set dragging state if this is first entrance
            if (dragCounter.current === 1) {
                setIsDragging(true);
            }
        }
    };

    const handleDragLeave = (e: React.DragEvent<HTMLDivElement>) => {
        // Only handle external file drops, not internal drag operations
        if (isValidDataTransfer(e.dataTransfer)) {
            e.preventDefault();
            e.stopPropagation();

            // Decrement counter when leaving any element
            dragCounter.current -= 1;

            // Only set dragging state to false if we've left all elements
            if (dragCounter.current === 0) {
                setIsDragging(false);
            }
        }
    };

    const handleDrop = (e: React.DragEvent<HTMLDivElement>) => {
        // Only handle external file drops, not internal drag operations
        const files = Array.from(e.dataTransfer.files);
        if (files.length > 0 && onUploadFiles) {
            e.preventDefault();
            e.stopPropagation();

            // Reset counter and dragging state
            dragCounter.current = 0;
            setIsDragging(false);

            onUploadFiles(files);
        }
    };

    const createItems = getCreateMenuItems({
        onCreateFolder,
        onUploadFile,
        onCreateDoc,
        onCreateStickies,
        onCreateChat,
        onCreateSlides,
        onCreateSheets,
    });

    if (isLoading) {
        return <LoadingState />;
    }

    if (error) {
        return <ErrorState message="Error loading files" detail={error.message} />;
    }

    const contentDiv = (
        <div
            className={cn('h-full flex flex-col relative border-r', isDragging && 'bg-secondary/30')}
            onDragOver={handleDragOver}
            onDragEnter={handleDragEnter}
            onDragLeave={handleDragLeave}
            onDrop={handleDrop}
        >
            {allowUpload && isDragging && (
                <div className="absolute inset-0 bg-background/80 backdrop-blur-sm flex items-center justify-center z-10 pointer-events-none">
                    <div className="bg-card p-6 rounded-lg shadow-lg text-center">
                        <UploadIcon className="h-12 w-12 mx-auto mb-4 text-primary animate-bounce" />
                        <h3 className="text-xl font-medium mb-2">Drop files here</h3>
                        <p className="text-muted-foreground">Release to upload</p>
                    </div>
                </div>
            )}

            <DriveTable
                items={items}
                currentPath={currentPath}
                activeItemId={activeRowId}
                onItemClick={handleRowClick}
                onItemOpen={onRowActivate}
                onShareClick={onShareClick}
                getFileIcon={getFileIcon}
                onDownload={onDownload}
                allowDownload={allowDownload}
                onDelete={onDelete}
                allowDelete={allowDelete}
                onRename={onRename}
                onMove={onMove}
                ancestorBreadcrumb={breadcrumbPaths ?? []}
                onQuickLook={onQuickLook}
                sortFn={sortFn}
            />

            {items.length === 0 && <EmptyState />}
        </div>
    );

    if (createItems.length === 0) return contentDiv;

    return (
        <ContextMenu>
            <ContextMenuTrigger asChild>{contentDiv}</ContextMenuTrigger>
            <ContextMenuContent>
                {createItems.map(({ key, icon: Icon, label, onSelect }) => (
                    <ContextMenuItem key={key} onSelect={onSelect}>
                        <Icon className="h-4 w-4 mr-2" />
                        {label}
                    </ContextMenuItem>
                ))}
            </ContextMenuContent>
        </ContextMenu>
    );
}
