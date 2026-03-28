import {useNavigate} from '@tanstack/react-router';
import type {DrivePath} from '@workspace/lib/types/drive';
import {SidebarItem, StorageUsage} from '@workspace/ui';
import {Button} from '@workspace/ui/components/button';
import {SidebarHeader} from '@workspace/ui/components/layout/sidebar/sidebar-header';
import {SidebarSection} from '@workspace/ui/components/layout/sidebar/sidebar-section';
import {Download, Plus, UsersRound} from 'lucide-react';
import {useState} from 'react';
import type {EigenDocAppConfig} from './eigendoc-config';

type EigenDocSidebarProps = {
    config: EigenDocAppConfig;
    condensed?: boolean;
    onClose?: () => void;
    isMobile?: boolean;
    rootPath?: DrivePath | null;
};

export function EigenDocSidebar({
                                    config,
                                    condensed = false,
                                    onClose,
                                    isMobile = false,
                                    rootPath = null,
                                }: EigenDocSidebarProps) {
    const [createOpen, setCreateOpen] = useState(false);
    const navigate = useNavigate();
    const CreateDialog = config.createDialog;

    return (
        <div className="flex h-full min-h-[calc(100vh-3.5rem)] flex-col">
            {isMobile && <SidebarHeader appName={config.appName} onClose={onClose}/>}
            <div className="px-3 py-2">
                <Button
                    variant="default"
                    size={condensed ? 'icon' : 'default'}
                    className={`${condensed ? 'w-10 p-0' : 'w-full justify-start gap-3'}`}
                    onClick={() => setCreateOpen(true)}
                >
                    <Plus className="h-4 w-4"/>
                    {!condensed && <span>{config.newLabel}</span>}
                </Button>
            </div>

            <SidebarSection condensed={condensed}>
                <SidebarItem
                    icon={<config.icon className="h-4 w-4"/>}
                    to="/"
                    label={config.allLabel}
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
                <CreateDialog
                    path={rootPath}
                    open={createOpen}
                    onOpenChange={setCreateOpen}
                    onCancel={() => setCreateOpen(false)}
                    onAfterAction={() => navigate({to: '/'})}
                />
            )}
        </div>
    );
}
