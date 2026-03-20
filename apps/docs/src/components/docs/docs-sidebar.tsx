import {Download, FileText, Plus, UsersRound} from 'lucide-react';
import {Button} from "@workspace/ui/components/button";
import {SidebarSection} from '@workspace/ui/components/layout/sidebar/sidebar-section';
import {SidebarHeader} from '@workspace/ui/components/layout/sidebar/sidebar-header';
import {SidebarItem, StorageUsage} from "@workspace/ui";
import {DrivePath} from "@workspace/lib/types/drive";
import {useState} from 'react';
import {useNavigate} from '@tanstack/react-router';

import {DriveCreateDoc} from '@workspace/ui/components/layout/drive/drive-create-doc';

type DocsSidebarProps = {
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
    const [createDocOpen, setCreateDocOpen] = useState(false);
    const navigate = useNavigate();

    const targetPath = rootPath;

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
            {isMobile && <SidebarHeader appName="docs" onClose={onClose}/>}

            <div className="px-3 py-2">
                <Button
                    variant="default"
                    size={condensed ? "icon" : "default"}
                    className={`${condensed ? 'w-10 p-0' : 'w-full justify-start gap-3'}`}
                    onClick={() => setCreateDocOpen(true)}
                >
                    <Plus className="h-4 w-4"/>
                    {!condensed && <span>New document</span>}
                </Button>
            </div>

            <SidebarSection
                condensed={condensed}
            >
                <SidebarItem
                    icon={<FileText className="h-4 w-4"/>}
                    to="/mime/application-eigendoc"
                    label="All docs"
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
                <DriveCreateDoc
                    path={targetPath}
                    open={createDocOpen}
                    onOpenChange={setCreateDocOpen}
                    onSave={() => {
                    }}
                    onCancel={() => setCreateDocOpen(false)}
                    onAfterAction={handleAfterAction}
                />
            )}
        </div>
    );
}