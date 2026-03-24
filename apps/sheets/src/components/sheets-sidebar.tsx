import {Download, Plus, Sheet, UsersRound} from 'lucide-react';
import {Button} from "@workspace/ui/components/button";
import {SidebarSection} from '@workspace/ui/components/layout/sidebar/sidebar-section';
import {SidebarHeader} from '@workspace/ui/components/layout/sidebar/sidebar-header';
import {SidebarItem, StorageUsage} from "@workspace/ui";
import {DrivePath} from '@workspace/lib/types/drive';
import {useState} from 'react';
import {useNavigate} from '@tanstack/react-router';

import {DriveCreateSheets} from '@workspace/ui/components/layout/drive/drive-create-sheets';

type SheetsSidebarProps = {
    condensed?: boolean;
    onClose?: () => void;
    isMobile?: boolean;
    rootPath?: DrivePath | null;
}

export function SheetsSidebar({
                                  condensed = false,
                                  onClose,
                                  isMobile = false,
                                  rootPath = null,
                              }: SheetsSidebarProps) {
    const navigate = useNavigate();
    const [createSheetsOpen, setCreateSheetsOpen] = useState(false);
    const targetPath = rootPath;

    const handleAfterAction = () => {
        navigate({to: '/'});
    };

    return (
        <div className="flex h-full min-h-[calc(100vh-3.5rem)] flex-col">
            {isMobile && <SidebarHeader appName="sheets" onClose={onClose}/>}
            <div className="px-3 py-2">
                <Button
                    variant="default"
                    size={condensed ? "icon" : "default"}
                    className={`${condensed ? 'w-10 p-0' : 'w-full justify-start gap-3'}`}
                    onClick={() => setCreateSheetsOpen(true)}
                >
                    <Plus className="h-4 w-4"/>
                    {!condensed && <span>New sheet</span>}
                </Button>
            </div>

            <SidebarSection
                condensed={condensed}
            >

                <SidebarItem
                    icon={<Sheet className="h-4 w-4"/>}
                    to="/"
                    label="All sheets"
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

            <StorageUsage
                className="mt-auto"
                condensed={condensed}
            />

            {targetPath && (
                <DriveCreateSheets
                    path={targetPath}
                    open={createSheetsOpen}
                    onOpenChange={setCreateSheetsOpen}
                    onCancel={() => setCreateSheetsOpen(false)}
                    onAfterAction={handleAfterAction}
                />
            )}
        </div>
    );
}
