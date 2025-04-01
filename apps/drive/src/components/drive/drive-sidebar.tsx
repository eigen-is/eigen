import {FolderPlus, HardDrive, Upload, X, Plus, Folder} from 'lucide-react';
import {Button} from "@workspace/ui/components/button";
import {SidebarSection} from '@workspace/ui/components/layout/sidebar/sidebar-section';
import {AppLogo} from '@workspace/ui/components/layout/app-logo';
import {EigenLoader} from "@workspace/ui";
import {Link} from '@tanstack/react-router';
import {cn} from "@workspace/ui/lib/utils";
import {TooltipProvider, Tooltip, TooltipTrigger, TooltipContent} from "@workspace/ui/components/tooltip";

// Define proper types for drive items
interface DriveItem {
    id: string;
    name: string;
    type: 'folder' | 'file' | 'eigendocs';
    parentId?: string;
}

interface DriveSidebarProps {
    condensed?: boolean;
    onClose?: () => void;
    isMobile?: boolean;
    folders?: DriveItem[];
    isLoading?: boolean;
    error?: any;
    onCreateFolder?: () => void;
}

export function DriveSidebar({
                                 condensed = false,
                                 onClose,
                                 isMobile = false,
                                 folders = [],
                                 isLoading = false,
                                 error = false,
                                 onCreateFolder,
                             }: DriveSidebarProps) {
    // Filter to show only folders in the sidebar
    const folderItems = folders.filter(item => item.type === 'folder');

    return (
        <div className="flex h-full min-h-[calc(100vh-3.5rem)] flex-col">
            {isMobile && (
                <div className="flex items-center h-12 bg-app px-4">
                    <Button variant="ghost" size="icon" onClick={onClose}
                            className="mr-2 text-white hover:bg-primary/20 hover:text-white">
                        <X className="h-5 w-5"/>
                        <span className="sr-only">Close menu</span>
                    </Button>
                    <AppLogo appName="drive"/>
                </div>
            )}


            <SidebarSection 
                title={condensed ? undefined : "Folders"} 
                condensed={condensed}
            >
                {/* Show folders icon for condensed mode */}
                {condensed && <HardDrive className="h-4 w-4 mb-2" />}
                
                {isLoading ? (
                    <div className="flex items-center justify-center py-4">
                        <EigenLoader/>
                    </div>
                ) : error ? (
                    <div className="text-sm text-destructive px-3 py-2">
                        Failed to load folders
                    </div>
                ) : (
                    <div className="space-y-1 py-1">
                        {folderItems.length === 0 ? (
                            <div className="text-sm text-muted-foreground px-3 py-2">
                                No folders
                            </div>
                        ) : (
                            <>  
                            <FolderItem 
                                key={folderItems[0].parentId}
                                folder={{id: folderItems[0].parentId || "", name: "/", type: "folder"}}
                                condensed={condensed}
                            />
                            {folderItems.map((folder) => (
                                <FolderItem 
                                    key={folder.id}
                                    folder={folder}
                                    condensed={condensed}
                                    onCreateSubfolder={onCreateFolder}
                                />
                            ))}
                            </>
                        )}
                    </div>
                )}
            </SidebarSection>
        </div>
    );
}

interface FolderItemProps {
    folder: DriveItem;
    condensed: boolean;
    onCreateSubfolder?: () => void;
}

// Component for displaying an individual folder item in the sidebar
function FolderItem({ folder, condensed, onCreateSubfolder }: FolderItemProps) {
    return (
        <div className="flex items-center group px-2">
            <Link
                to="/fs/$pathId"
                params={{ pathId: folder.id }}
                className={cn(
                    "flex items-center rounded-md px-2 py-1.5 text-sm font-medium",
                    "hover:bg-muted hover:text-foreground",
                    "flex-1"
                )}
                activeProps={{
                    className: "bg-muted text-foreground"
                }}
                inactiveProps={{
                    className: "text-muted-foreground"
                }}
            >
                <Folder className="h-4 w-4 mr-2 shrink-0" />
                {!condensed && <span className="truncate">{folder.name}</span>}
            </Link>
            
            {!condensed && onCreateSubfolder && (
                <TooltipProvider>
                    <Tooltip>
                        <TooltipTrigger asChild>
                            <Button
                                variant="ghost"
                                size="icon"
                                className="h-7 w-7 opacity-0 group-hover:opacity-100 transition-opacity"
                                onClick={onCreateSubfolder}
                            >
                                <Plus className="h-3.5 w-3.5" />
                                <span className="sr-only">Create subfolder</span>
                            </Button>
                        </TooltipTrigger>
                        <TooltipContent>Create subfolder</TooltipContent>
                    </Tooltip>
                </TooltipProvider>
            )}
        </div>
    );
}
