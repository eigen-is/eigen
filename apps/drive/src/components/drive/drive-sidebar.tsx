import {Folder, X} from 'lucide-react';
import {Button} from "@workspace/ui/components/button";
import {SidebarSection} from '@workspace/ui/components/layout/sidebar/sidebar-section';
import {AppLogo} from '@workspace/ui/components/layout/app-logo';
import {EigenLoader, SidebarItem} from "@workspace/ui";
import React, {useMemo} from "react";

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
    // Filter to show only folders in the sidebar using useMemo
    const folderItems = useMemo(() => {
        return folders.filter(item => item.type === 'folder');
    }, [folders]);

    // @ts-ignore
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
                condensed={condensed}
            >

                {isLoading ? (
                    <div className="flex items-center justify-center py-4">
                        <EigenLoader/>
                    </div>
                ) : error ? (
                    <div className="text-sm text-destructive px-3 py-2">
                        Failed to load folders
                    </div>
                ) : (
                    (folderItems && folderItems.length === 0) ? (
                        <div className="text-sm text-muted-foreground px-3 py-2">
                            No folders
                        </div>
                    ) : (
                        <>
                            <SidebarItem
                                icon={<Folder className="h-4 w-4"/>}
                                key={folderItems[0].parentId}
                                to={`/fs/${folderItems[0].parentId}`}
                                label="/"
                                condensed={condensed}
                            />
                            {folderItems.map((folder) => (
                                <SidebarItem
                                    icon={<Folder className="h-4 w-4"/>}
                                    key={folder.id}
                                    to={`/fs/${folder.id}`}
                                    label={folder.name}
                                    condensed={condensed}
                                />
                            ))}
                        </>
                    )
                )}
            </SidebarSection>
        </div>
    );
}