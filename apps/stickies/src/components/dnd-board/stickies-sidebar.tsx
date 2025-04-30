import {Download, FileText, Plus, UsersRound, X} from 'lucide-react';
import {Button} from "@workspace/ui/components/button";
import {SidebarSection} from '@workspace/ui/components/layout/sidebar/sidebar-section';
import {AppLogo} from '@workspace/ui/components/layout/app-logo';
import {SidebarItem, StorageUsage} from "@workspace/ui";
import {DrivePath} from '@apps/api-server/types/drive';
import {useState} from 'react';
import {useNavigate} from '@tanstack/react-router';

// Import the create stickies component
import {DriveCreateStickies} from '@workspace/ui/components/layout/drive/drive-create-stickies';

interface StickiesSidebarProps {
    condensed?: boolean;
    onClose?: () => void;
    isMobile?: boolean;
    rootPath?: DrivePath | null;
}

export function StickiesSidebar({
                                    condensed = false,
                                    onClose,
                                    isMobile = false,
                                    rootPath = null,
                                }: StickiesSidebarProps) {
    const navigate = useNavigate();
    // Add state for tracking dialog open state
    const [createStickiesOpen, setCreateStickiesOpen] = useState(false);

    // Determine the target path for stickies creation
    const targetPath = rootPath;

    // Define afterAction callback to redirect to stickies mime type
    const handleAfterAction = () => {
        navigate({
            to: '/mime/$mimeType',
            params: {
                mimeType: 'application-eigenstickies'
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
                    <AppLogo appName="stickies"/>
                </div>
            )}


            <div className="px-3 py-2">
                <Button
                    variant="default"
                    size={condensed ? "icon" : "default"}
                    className={`${condensed ? 'w-10 p-0' : 'w-full justify-start gap-3'}`}
                    onClick={() => setCreateStickiesOpen(true)}
                >
                    <Plus className="h-4 w-4"/>
                    {!condensed && <span>New stickies</span>}
                </Button>
            </div>

            <SidebarSection
                condensed={condensed}
            >

                <SidebarItem
                    icon={<FileText className="h-4 w-4"/>}
                    to="/mime/application-eigenstickies"
                    label="All stickies"
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

            {/* Create Stickies Dialog */}
            {targetPath && (
                <DriveCreateStickies
                    path={targetPath}
                    open={createStickiesOpen}
                    onOpenChange={setCreateStickiesOpen}
                    onSave={() => {
                    }}
                    onCancel={() => setCreateStickiesOpen(false)}
                    onAfterAction={handleAfterAction}
                />
            )}
        </div>
    );
}