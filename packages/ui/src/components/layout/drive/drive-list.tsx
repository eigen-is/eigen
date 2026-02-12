import {Fragment, useRef, useState} from 'react';
import {Button} from "@workspace/ui/components/button";
import {EigenLoader} from "@workspace/ui";
import {FileText, FolderPlus, Plus, StickyNote, UploadIcon} from "lucide-react";
import {DriveTable, getFileIcon} from "@workspace/ui/components/layout/drive";
import {type DrivePath} from "@workspace/lib/types/drive";
import {cn} from "@workspace/ui/lib/utils";
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuTrigger
} from "@workspace/ui/components/dropdown-menu";
import {
    Breadcrumb,
    BreadcrumbItem,
    BreadcrumbLink,
    BreadcrumbList,
    BreadcrumbPage,
    BreadcrumbSeparator
} from "@workspace/ui/components/breadcrumb";
import {useBreadcrumb} from "@workspace/lib/drive";
import {useLayout} from "../layout-context";

type DriveListToolbarProps = {
    ownerId: string;
    mountId: string;
    pathId: string;
    showBreadcrumb?: boolean;
    onRowSelect?: (path: DrivePath) => void;
    onRowActivate?: (path: DrivePath) => void;
    activeRowId?: string;
    onCreateFolder?: () => void;
    onUploadFile?: () => void;
    onCreateDoc?: () => void;
    onCreateStickies?: () => void;
}

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
                                 }: DriveListToolbarProps) {
    const {data: breadcrumbPaths = []} = showBreadcrumb ? useBreadcrumb(ownerId, mountId, pathId) : {data: []};
    const {isMobile} = useLayout();

    const handleBreadcrumbClick = (path: DrivePath) => {
        if (path.id === activeRowId && onRowActivate) {
            onRowActivate(path);
        } else if (onRowSelect) {
            onRowSelect(path);
        }
    };

    const numberOfDropDownItems = (onCreateFolder ? 1 : 0) + (onUploadFile ? 1 : 0) + (onCreateDoc ? 1 : 0) + (onCreateStickies ? 1 : 0);

    const newItemButton = (onCreateFolder || onUploadFile || onCreateDoc || onCreateStickies) ? (
        (numberOfDropDownItems === 1 ? (
                    onCreateDoc ? <Button size="default" onClick={onCreateDoc}>
                        <Plus/>
                        <span className="mr-2">New document</span>
                    </Button> : onCreateStickies ?
                        <Button size="default" onClick={onCreateStickies}>
                            <Plus/>
                            <span className="mr-2">New stickies</span>
                        </Button> : null
                ) :
                <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                        <Button size="default">
                            <Plus/>
                            <span className="mr-2">New</span>
                        </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                        {onCreateFolder && (
                            <DropdownMenuItem onClick={onCreateFolder}>
                                <FolderPlus className="h-4 w-4 mr-2"/>
                                Create folder
                            </DropdownMenuItem>
                        )}
                        {onUploadFile && (
                            <DropdownMenuItem onClick={onUploadFile}>
                                <UploadIcon className="h-4 w-4 mr-2"/>
                                Upload file
                            </DropdownMenuItem>
                        )}
                        {onCreateDoc && (
                            <DropdownMenuItem onClick={onCreateDoc}>
                                <FileText className="h-4 w-4 mr-2"/>
                                Create document
                            </DropdownMenuItem>
                        )}
                        {onCreateStickies && (
                            <DropdownMenuItem onClick={onCreateStickies}>
                                <StickyNote className="h-4 w-4 mr-2"/>
                                Create stickies
                            </DropdownMenuItem>
                        )}
                    </DropdownMenuContent>
                </DropdownMenu>
        )) : null;

    return (
        <div className="flex items-center justify-between w-full">
            {showBreadcrumb ? <Breadcrumb className="overflow-hidden">
                <BreadcrumbList>
                    {breadcrumbPaths.map((path, index) => (
                        <Fragment key={path.id}>
                            {index > 0 && <BreadcrumbSeparator/>}
                            <BreadcrumbItem>
                                {index === breadcrumbPaths.length - 1 ? (
                                    <BreadcrumbPage className="flex items-center">
                                        {path.name}
                                    </BreadcrumbPage>
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
            </Breadcrumb> : <div className="flex-1"/>}
            <div className="flex gap-1">
                {isMobile && newItemButton}
            </div>
        </div>
    );
}

interface DriveListProps {
    items: DrivePath[];
    isLoading?: boolean;
    error?: Error | null;
    onRowSelect?: (path: DrivePath) => void;
    onRowActivate?: (path: DrivePath) => void;
    activeRowId?: string;
    onCreateFolder?: () => void;
    onUploadFile?: () => void;
    onUploadFiles?: (files: File[]) => void;
    currentPath?: DrivePath | null;
    onDelete?: (path: DrivePath) => void;
    onShareClick?: (item: DrivePath) => void;
    onCreateDoc?: () => void;
    onCreateStickies?: () => void;
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
}

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
                              onDownload,
                              ownerId,
                              mountId,
                              pathId,
                              showBreadcrumb = true,
                              allowDelete = false,
                              allowDownload = false,
                              allowUpload = false,
                              onRename,
                              onMove,
                          }: DriveListProps) {
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

    // Handle showing empty, loading, and error states
    if (isLoading) {
        return (
            <div className="h-full flex flex-col items-center justify-center p-8">
                <EigenLoader/>
            </div>
        );
    }

    if (error) {
        return (
            <div className="h-full flex flex-col items-center justify-center p-8 text-center">
                <p className="text-destructive mb-2">Error loading files</p>
                <p className="text-muted-foreground text-sm">{error.message}</p>
            </div>
        );
    }

    return (
        <div
            className={cn(
                "h-full flex flex-col relative border-r",
                isDragging && "bg-secondary/30"
            )}
            onDragOver={handleDragOver}
            onDragEnter={handleDragEnter}
            onDragLeave={handleDragLeave}
            onDrop={handleDrop}
        >
            {/* Drag overlay */}
            {allowUpload && isDragging && (
                <div
                    className="absolute inset-0 bg-background/80 backdrop-blur-sm flex items-center justify-center z-10 pointer-events-none">
                    <div className="bg-card p-6 rounded-lg shadow-lg text-center">
                        <UploadIcon className="h-12 w-12 mx-auto mb-4 text-primary animate-bounce"/>
                        <h3 className="text-xl font-medium mb-2">Drop files here</h3>
                        <p className="text-muted-foreground">Release to upload</p>
                    </div>
                </div>
            )}

            {/* Drive table */}
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
            />

            {items.length === 0 && (
                <div className="flex-1 flex flex-col items-center justify-top text-center">
                    <p className="text-muted-foreground mb-4">Within this void, all possibilities are yet
                        unobserved.</p>
                    {/* <div className="flex gap-2">
                        {newItemButton}
                    </div> */}
                </div>
            )}
        </div>
    );
}
