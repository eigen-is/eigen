import {useMemo, useState} from 'react';
import {Button} from "@workspace/ui/components/button";
import {EigenLoader} from "@workspace/ui";
import {FolderPlus, Search, UploadIcon} from "lucide-react";
import {Input} from "@workspace/ui/components/input";
import {DrivePathItem, DriveTable, getFileIcon} from "@workspace/ui/components/layout/drive";
import {cn} from "@workspace/ui/lib/utils";

interface DriveListProps {
    items: DrivePathItem[];
    isLoading?: boolean;
    error?: Error | null;
    onRowClick?: (path: DrivePathItem) => void;
    activeRowId?: string;
    onCreateFolder?: () => void;
    onUploadFile?: () => void;
    onUploadFiles?: (files: File[]) => void; 
    currentPath?: DrivePathItem | null;
    onDelete?: (path: DrivePathItem) => void;
}

export function DriveList({
                              items = [],
                              isLoading = false,
                              error = null,
                              onRowClick,
                              activeRowId,
                              onCreateFolder,
                              onUploadFile,
                              onUploadFiles,
                              onDelete,
                              currentPath,
                          }: DriveListProps) {
    const [searchTerm, setSearchTerm] = useState('');
    const [isDragging, setIsDragging] = useState(false);

    // Filter items based on search term
    // Use useMemo to prevent unnecessary filtering on each render
    const filteredItems = useMemo(() => {
        return items.filter(item =>
            item.name.toLowerCase().includes(searchTerm.toLowerCase())
        );
    }, [items, searchTerm]);

    // Drag and drop handlers
    const handleDragOver = (e: React.DragEvent<HTMLDivElement>) => {
        e.preventDefault(); 
        e.stopPropagation();
    };

    const handleDragEnter = (e: React.DragEvent<HTMLDivElement>) => {
        e.preventDefault();
        e.stopPropagation();
        setIsDragging(true);
    };

    const handleDragLeave = (e: React.DragEvent<HTMLDivElement>) => {
        e.preventDefault();
        e.stopPropagation();
        setIsDragging(false);
    };

    const handleDrop = (e: React.DragEvent<HTMLDivElement>) => {
        e.preventDefault();
        e.stopPropagation();
        setIsDragging(false);
        
        const files = Array.from(e.dataTransfer.files);
        if (files.length > 0 && onUploadFiles) {
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
                "h-full flex flex-col relative",
                isDragging && "bg-secondary/30"
            )}
            onDragOver={handleDragOver}
            onDragEnter={handleDragEnter}
            onDragLeave={handleDragLeave}
            onDrop={handleDrop}
        >
            {/* Drag overlay */}
            {isDragging && (
                <div className="absolute inset-0 bg-background/80 backdrop-blur-sm flex items-center justify-center z-10 pointer-events-none">
                    <div className="bg-card p-6 rounded-lg shadow-lg text-center">
                        <UploadIcon className="h-12 w-12 mx-auto mb-4 text-primary animate-bounce" />
                        <h3 className="text-xl font-medium mb-2">Drop files here</h3>
                        <p className="text-muted-foreground">Release to upload</p>
                    </div>
                </div>
            )}
            
            {/* Search and actions toolbar */}
            <div className="h-12 flex items-center justify-between border-b px-2">
                {/* Search - hidden on small screens */}
                <div className="relative flex-1 max-w-xs hidden sm:block">
                    <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground"/>
                    <Input
                        type="search"
                        placeholder="Search files..."
                        className="pl-8 h-9"
                        value={searchTerm}
                        onChange={(e) => setSearchTerm(e.target.value)}
                    />
                </div>

                {/* Mobile search button */}
                <div className="sm:hidden">
                    <Button
                        variant="ghost"
                        size="icon"
                        className="h-9 w-9"
                        title="Search"
                    >
                        <Search className="h-4 w-4"/>
                    </Button>
                </div>

                <div className="flex gap-1">
                    {onCreateFolder && (
                        <Button
                            variant="outline"
                            size="sm"
                            className="h-9"
                            onClick={onCreateFolder}
                        >
                            <FolderPlus className="h-4 w-4 sm:mr-2"/>
                            <span className="hidden sm:inline">New Folder</span>
                        </Button>
                    )}
                    {onUploadFile && (
                        <Button
                            variant="default"
                            size="sm"
                            className="h-9"
                            onClick={onUploadFile}
                        >
                            <UploadIcon className="h-4 w-4 sm:mr-2"/>
                            <span className="hidden sm:inline">Upload</span>
                        </Button>
                    )}
                </div>
            </div>

            {/* Drive table */}
            <DriveTable
                items={filteredItems}
                currentPath={currentPath}
                activeItemId={activeRowId}
                onItemClick={onRowClick}
                getFileIcon={getFileIcon}
            />

            {filteredItems.length === 0 && (
                <div className="flex-1 flex flex-col items-center justify-top text-center">
                    <p className="text-muted-foreground mb-4">This folder is empty</p>
                    <div className="flex gap-2">
                        {onCreateFolder && (
                            <Button
                                variant="outline"
                                size="sm"
                                className="h-9"
                                onClick={onCreateFolder}
                            >
                                <FolderPlus className="h-4 w-4 mr-2"/>
                                New Folder
                            </Button>
                        )}
                        {onUploadFile && (
                            <Button
                                variant="default"
                                size="sm"
                                className="h-9"
                                onClick={onUploadFile}
                            >
                                <UploadIcon className="h-4 w-4 mr-2"/>
                                Upload
                            </Button>
                        )}
                    </div>
                </div>
            )}
        </div>
    );
}
