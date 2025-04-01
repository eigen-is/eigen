import {useState} from 'react';
import {DrivePath} from "@apps/api-server/types/drive";
import {Button} from "@workspace/ui/components/button";
import {
    Table,
    TableHeader,
    TableBody,
    TableRow,
    TableHead,
    TableCell
} from "@workspace/ui/components/table";
import {EigenLoader} from "@workspace/ui";
import {
    File,
    Folder,
    FolderPlus,
    MoreHorizontal,
    Search, UploadIcon
} from "lucide-react";
import {Input} from "@workspace/ui/components/input";
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuTrigger
} from "@workspace/ui/components/dropdown-menu";
import {cn} from "@workspace/ui/lib/utils";
import {formatDistanceToNow} from "date-fns";

interface DriveListProps {
    items: DrivePath[];
    isLoading?: boolean;
    error?: Error | null;
    onRowClick?: (path: DrivePath) => void;
    activeRowId?: string;
    onCreateFolder?: () => void;
    onUploadFile?: () => void;
    currentPath?: DrivePath | null;
}

export function DriveList({
                              items = [],
                              isLoading = false,
                              error = null,
                              onRowClick,
                              activeRowId,
                              onCreateFolder,
                              onUploadFile,
                              currentPath
                          }: DriveListProps) {
    const [searchTerm, setSearchTerm] = useState('');

    // Filter items based on search term
    const filteredItems = items.filter(item =>
        item.name.toLowerCase().includes(searchTerm.toLowerCase())
    );

    // Handle showing empty, loading, and error states
    if (isLoading) {
        return (
            <div className="w-full h-full flex flex-col overflow-hidden bg-white">
                <div className="flex-1 flex items-center justify-center">
                    <EigenLoader/>
                </div>
            </div>
        );
    }

    if (error) {
        return (
            <div className="w-full h-full flex flex-col overflow-hidden bg-white">
                <div className="flex-1 flex flex-col items-center justify-center gap-4">
                    <p className="text-red-500">Failed to load folder content</p>
                    <p className="text-sm text-muted-foreground">{error.message}</p>
                </div>
            </div>
        );
    }

    return (
        <div className="w-full h-full flex flex-col overflow-hidden bg-white">
            {/* Header with search and actions */}
            <div className="p-4 border-b flex items-center justify-between gap-2">
                <div className="relative flex-1 max-w-md">
                    <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground"/>
                    <Input
                        type="search"
                        placeholder="Search files and folders..."
                        className="pl-8"
                        value={searchTerm}
                        onChange={(e) => setSearchTerm(e.target.value)}
                    />
                </div>

                <div className="flex items-center gap-2">
                    <Button
                        onClick={onUploadFile}
                        size="sm"
                        className="flex items-center gap-1"
                    >
                        <UploadIcon className="h-4 w-4"/>
                        <span>Upload</span>
                    </Button>

                    {onCreateFolder && (
                        <Button
                            onClick={onCreateFolder}
                            size="sm"
                            className="flex items-center gap-1"
                        >
                            <FolderPlus className="h-4 w-4"/>
                            <span>New Folder</span>
                        </Button>
                    )}
                </div>
            </div>

            {/* Table listing files and folders */}
            <div className="flex-1 overflow-auto">
                <Table>
                    <TableHeader>
                        <TableRow>
                            <TableHead className="w-[50%]">Name</TableHead>
                            <TableHead>Type</TableHead>
                            <TableHead>Modified</TableHead>
                            <TableHead className="w-[50px]"></TableHead>
                        </TableRow>
                    </TableHeader>
                    <TableBody>
                        {/* Parent folder navigation row */}
                        {currentPath?.parentId && (
                            <TableRow
                                className="cursor-pointer hover:bg-muted/50"
                                onClick={() => onRowClick && onRowClick({
                                    id: currentPath.parentId || '',
                                    name: '..',
                                    type: 'folder',
                                    parentId: undefined,
                                    ownerId: '',
                                    labels: [],
                                    mimeType: 'folder',
                                    acl: null,
                                    createdAt: new Date(),
                                    updatedAt: new Date()
                                })}
                            >
                                <TableCell className="font-medium">
                                    <div className="flex items-center">
                                        <Folder className="h-4 w-4 mr-2 text-muted-foreground"/>
                                        <span>..</span>
                                    </div>
                                </TableCell>
                                <TableCell>Folder</TableCell>
                                <TableCell>-</TableCell>
                                <TableCell>-</TableCell>
                            </TableRow>
                        )}

                        {filteredItems.map((item) => (
                            <TableRow
                                key={item.id}
                                className={cn(
                                    "cursor-pointer hover:bg-muted/50",
                                    activeRowId === item.id && "bg-muted"
                                )}
                                onClick={() => onRowClick && onRowClick(item)}
                            >
                                <TableCell className="font-medium">
                                    <div className="flex items-center">
                                        {item.type === 'folder' ? (
                                            <Folder className="h-4 w-4 mr-2 text-muted-foreground"/>
                                        ) : (
                                            <File className="h-4 w-4 mr-2 text-muted-foreground"/>
                                        )}
                                        <span className="truncate">{item.name}</span>
                                    </div>
                                </TableCell>
                                <TableCell>
                                    {item.type === 'folder' ? 'Folder' :
                                        item.type === 'eigendocs' ? 'EigenDocs' : 'File'}
                                </TableCell>
                                <TableCell>
                                    {item.updatedAt ?
                                        formatDistanceToNow(new Date(item.updatedAt), {addSuffix: true}) :
                                        'Unknown'}
                                </TableCell>
                                <TableCell>
                                    <DropdownMenu>
                                        <DropdownMenuTrigger asChild>
                                            <Button
                                                variant="ghost"
                                                size="icon"
                                                onClick={(e) => e.stopPropagation()}
                                            >
                                                <MoreHorizontal className="h-4 w-4"/>
                                                <span className="sr-only">Open menu</span>
                                            </Button>
                                        </DropdownMenuTrigger>
                                        <DropdownMenuContent align="end">
                                            <DropdownMenuItem>Rename</DropdownMenuItem>
                                            <DropdownMenuItem>Delete</DropdownMenuItem>
                                        </DropdownMenuContent>
                                    </DropdownMenu>
                                </TableCell>
                            </TableRow>
                        ))}
                    </TableBody>
                </Table>
                {filteredItems.length === 0 && (
                    <div className="h-full flex flex-col items-center justify-center p-8 text-center">
                        <p className="text-muted-foreground mb-2">This folder is empty</p>
                        {onCreateFolder && (
                            <Button
                                variant="outline"
                                onClick={onCreateFolder}
                                className="mt-4"
                            >
                                <FolderPlus className="h-4 w-4 mr-2"/>
                                Create a folder
                            </Button>
                        )}
                    </div>
                )}
            </div>
        </div>
    );
}
