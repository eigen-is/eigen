import {Download, FileText, Plus, UsersRound} from 'lucide-react';
import {Button} from '@workspace/ui/components/button';
import {SidebarSection} from '@workspace/ui/components/layout/sidebar/sidebar-section';
import {SidebarHeader} from '@workspace/ui/components/layout/sidebar/sidebar-header';
import {SidebarItem, StorageUsage} from '@workspace/ui';
import {useState} from 'react';
import {useNavigate} from '@tanstack/react-router';
import {DriveCreateStickies} from '@workspace/ui/components/layout/drive/drive-create-stickies';
import type {DrivePath} from '@workspace/lib/types/drive';

type SidebarProps = {
    condensed?: boolean;
    onClose?: () => void;
    isMobile?: boolean;
    rootPath?: DrivePath | null;
}

export function StickiesSidebar({condensed = false, onClose, isMobile = false, rootPath = null}: SidebarProps) {
    const navigate = useNavigate();
    const [createStickiesOpen, setCreateStickiesOpen] = useState(false);

    const handleAfterAction = () => {
        navigate({to: '/'});
    };

    return (
        <div className="flex h-full min-h-[calc(100vh-3.5rem)] flex-col">
            {isMobile && <SidebarHeader appName="stickies" onClose={onClose}/>}
            <div className="px-3 py-2">
                <Button
                    variant="default"
                    size={condensed ? 'icon' : 'default'}
                    className={`${condensed ? 'w-10 p-0' : 'w-full justify-start gap-3'}`}
                    onClick={() => setCreateStickiesOpen(true)}
                >
                    <Plus className="h-4 w-4"/>
                    {!condensed && <span>New stickies</span>}
                </Button>
            </div>

            <SidebarSection condensed={condensed}>
                <SidebarItem
                    icon={<FileText className="h-4 w-4"/>}
                    to="/"
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

            <StorageUsage className="mt-auto" condensed={condensed}/>

            {rootPath && (
                <DriveCreateStickies
                    path={rootPath}
                    open={createStickiesOpen}
                    onOpenChange={setCreateStickiesOpen}
                    onCancel={() => setCreateStickiesOpen(false)}
                    onAfterAction={handleAfterAction}
                />
            )}
        </div>
    );
}
