import {Download, FileText, Home, UsersRound, X} from 'lucide-react';
import {Button} from "@workspace/ui/components/button";
import {SidebarSection} from '@workspace/ui/components/layout/sidebar/sidebar-section';
import {AppLogo} from '@workspace/ui/components/layout/app-logo';
import {SidebarItem, StorageUsage} from "@workspace/ui";

interface DocsSidebarProps {
    condensed?: boolean;
    onClose?: () => void;
    isMobile?: boolean;
    error?: any;
    onCreateFolder?: () => void;
    rootPath?: string;
}

export function DocsSidebar({
                                 condensed = false,
                                 onClose,
                                 isMobile = false,
                                 error = false,
                                 onCreateFolder,
                                 rootPath = "/",
                             }: DocsSidebarProps) {
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

            <SidebarSection
                condensed={condensed}
            >
                <SidebarItem
                    icon={<Home className="h-4 w-4"/>}
                    to={rootPath}
                    label="Drive"
                    condensed={condensed}
                />

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
        </div>
    );
}