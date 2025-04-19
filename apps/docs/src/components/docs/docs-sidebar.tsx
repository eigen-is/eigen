import {FileText, X, Plus, UsersRound, Download} from 'lucide-react';
import {Button} from "@workspace/ui/components/button";
import {SidebarSection} from '@workspace/ui/components/layout/sidebar/sidebar-section';
import {AppLogo} from '@workspace/ui/components/layout/app-logo';
import {SidebarItem, StorageUsage} from "@workspace/ui";
import {DrivePath} from "@apps/api-server/types/drive";
import { useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { 
    DropdownMenu,
    DropdownMenuTrigger,
    DropdownMenuContent,
    DropdownMenuItem
} from '@workspace/ui/components/dropdown-menu';

// Import the doc creation component directly
import { DriveCreateDoc } from '@workspace/ui/components/layout/drive/drive-create-doc';

interface DocsSidebarProps {
    condensed?: boolean;
    onClose?: () => void;
    isMobile?: boolean;
    rootPath?: DrivePath | null;
}

export function DocsSidebar({
                                 condensed = false,
                                 onClose,
                                 isMobile = false,
                                 rootPath = null,
                             }: DocsSidebarProps) {
    // Dialog open state
    const [createDocOpen, setCreateDocOpen] = useState(false);
    const navigate = useNavigate();
    
    // Determine the target path for document creation
    const targetPath = rootPath;

    // Define afterAction callback to redirect to docs mime type
    const handleAfterAction = () => {
        navigate({
            to: '/mime/$mimeType',
            params: {
                mimeType: 'application-eigendoc'
            }
        });
    };

    return (
        <div className="flex h-full min-h-[calc(100vh-3.5rem)] flex-col">
            {isMobile && (
                <div className="flex items-center h-12 bg-app px-4">
                    <Button variant="ghost" size="icon" onClick={onClose}
                            className="mr-2 text-white hover:bg-primary/20 hover:text-white">
                        <X className="h-5 w-5"/>
                        <span className="sr-only">Close menu</span>
                    </Button>
                    <AppLogo appName="docs"/>
                </div>
            )}

            {/* New button dropdown */}
            <div className="px-3 py-2">
                <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                        <Button
                            variant="default"
                            size={condensed ? "icon" : "default"}
                            className={`${condensed ? 'w-10 p-0' : 'w-full justify-start gap-3'}`}
                        >
                            <Plus className="h-4 w-4"/>
                            {!condensed && <span>New</span>}
                        </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align={condensed ? "center" : "start"}>
                        <DropdownMenuItem onClick={() => setCreateDocOpen(true)}>
                            <FileText className="h-4 w-4 mr-2"/>
                            Create document
                        </DropdownMenuItem>
                    </DropdownMenuContent>
                </DropdownMenu>
            </div>

            <SidebarSection
                condensed={condensed}
            >
                <SidebarItem
                    icon={<FileText className="h-4 w-4"/>}
                    to="/mime/application-eigendoc"
                    label="All my docs"
                    condensed={condensed}
                />
                <SidebarItem
                    icon={<UsersRound className="h-4 w-4"/>}
                    to="/shared/by-me"
                    label="Shared by me"
                    condensed={condensed}
                />
                <SidebarItem
                    icon={<Download className="h-4 w-4"/>}
                    to="/shared/with-me"
                    label="Shared with me"
                    condensed={condensed}
                />
            </SidebarSection>

            {/* Storage usage indicator at the bottom of sidebar */}
            <StorageUsage
                className="mt-auto"
                condensed={condensed}
            />

            {/* Create Doc Dialog */}
            {targetPath && (
                <DriveCreateDoc
                    path={targetPath}
                    open={createDocOpen}
                    onOpenChange={setCreateDocOpen}
                    onSave={() => {}}
                    onCancel={() => setCreateDocOpen(false)}
                    onAfterAction={handleAfterAction}
                />
            )}
        </div>
    );
}