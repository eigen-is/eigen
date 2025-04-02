import {useMemo, useState} from 'react';
import {Button} from "@workspace/ui/components/button";
import {EigenLoader} from "@workspace/ui";
import {FolderPlus, Search, UploadIcon} from "lucide-react";
import {Input} from "@workspace/ui/components/input";
import {DrivePathItem, DriveTable, getFileIcon} from "@workspace/ui/components/layout/drive";

interface DriveListProps {
    items: DrivePathItem[];
    isLoading?: boolean;
    error?: Error | null;
    onRowClick?: (path: DrivePathItem) => void;
    activeRowId?: string;
    onCreateFolder?: () => void;
    onUploadFile?: () => void;
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
                              onDelete,
                              currentPath,
                          }: DriveListProps) {
    const [searchTerm, setSearchTerm] = useState('');

    // Filter items based on search term
    // Use useMemo to prevent unnecessary filtering on each render
    const filteredItems = useMemo(() => {
        return items.filter(item =>
            item.name.toLowerCase().includes(searchTerm.toLowerCase())
        );
    }, [items, searchTerm]);

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
        <div className="h-full flex flex-col">
            {/* Search and actions toolbar */}
            <div className="h-12 flex items-center justify-between border-b flex-col sm:flex-row gap-2 pl-2 pr-2">
                <div className="relative flex-1">
                    <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground"/>
                    <Input
                        type="search"
                        placeholder="Search files..."
                        className="pl-8"
                        value={searchTerm}
                        onChange={(e) => setSearchTerm(e.target.value)}
                    />
                </div>
                <div className="flex gap-2 justify-end">
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
