import { useMyTeams } from '@workspace/lib/home';
import { teamOwnerId } from '@workspace/lib/types';
import type { DrivePath } from '@workspace/lib/types/drive';
import { SidebarItem, StorageUsage, UserAvatar } from '@workspace/ui';
import { Button } from '@workspace/ui/components/button';
import { SidebarHeader } from '@workspace/ui/components/layout/sidebar/sidebar-header';
import { SidebarSection } from '@workspace/ui/components/layout/sidebar/sidebar-section';
import { Separator } from '@workspace/ui/components/separator';
import { Download, Plus, UsersRound } from 'lucide-react';
import { useState } from 'react';
import { DriveCreateEigenDoc } from './drive-create-eigendoc';
import type { EigenDocAppConfig } from './eigendoc-config';

type EigenDocSidebarProps = {
    config: EigenDocAppConfig;
    condensed?: boolean;
    onClose?: () => void;
    isMobile?: boolean;
    rootPath?: DrivePath | null;
};

export function GuestEigenDocSidebar({
    config,
    condensed = false,
    onClose,
    isMobile = false,
}: Omit<EigenDocSidebarProps, 'rootPath'>) {
    return (
        <div className="flex h-full min-h-[calc(100vh-3.5rem)] flex-col">
            {isMobile && <SidebarHeader appName={config.appName} onClose={onClose} />}
            <SidebarSection condensed={condensed}>
                <SidebarItem
                    icon={<config.icon className="h-4 w-4" />}
                    to="/"
                    label={config.allLabel}
                    condensed={condensed}
                />
                <SidebarItem
                    icon={<Download className="h-4 w-4" />}
                    to="/shared/with-me"
                    label="Shared with me"
                    condensed={condensed}
                />
            </SidebarSection>
        </div>
    );
}

export function EigenDocSidebar({
    config,
    condensed = false,
    onClose,
    isMobile = false,
    rootPath = null,
}: EigenDocSidebarProps) {
    const [createOpen, setCreateOpen] = useState(false);
    const { data: myTeams } = useMyTeams();

    return (
        <div className="flex h-full min-h-[calc(100vh-3.5rem)] flex-col">
            {isMobile && <SidebarHeader appName={config.appName} onClose={onClose} />}
            <div className="px-3 py-2">
                <Button
                    variant="default"
                    size={condensed ? 'icon' : 'default'}
                    className={`${condensed ? 'w-10 p-0' : 'w-full justify-start gap-3'}`}
                    onClick={() => setCreateOpen(true)}
                >
                    <Plus className="h-4 w-4" />
                    {!condensed && <span>{config.newLabel}</span>}
                </Button>
            </div>

            <SidebarSection condensed={condensed}>
                <SidebarItem
                    icon={<config.icon className="h-4 w-4" />}
                    to="/"
                    label={config.allLabel}
                    condensed={condensed}
                />
                <SidebarItem
                    icon={<UsersRound className="h-4 w-4" />}
                    to="/shared/by-me"
                    label="Shared by me"
                    condensed={condensed}
                />
                <SidebarItem
                    icon={<Download className="h-4 w-4" />}
                    to="/shared/with-me"
                    label="Shared with me"
                    condensed={condensed}
                />
            </SidebarSection>

            {myTeams?.some((t) => t.mounts.length > 0) && (
                <>
                    <Separator />
                    <SidebarSection condensed={condensed} title={condensed ? undefined : 'Shared Drives'}>
                        {myTeams.flatMap((team) =>
                            team.mounts
                                .filter((mount) => mount.rootPathId)
                                .map((mount) => (
                                    <SidebarItem
                                        key={`${team.id}-${mount.id}`}
                                        icon={<UserAvatar email={teamOwnerId(team.id)} className="h-4 w-4" />}
                                        to={`/drive/${teamOwnerId(team.id)}/${mount.id}`}
                                        label={mount.name}
                                        condensed={condensed}
                                    />
                                )),
                        )}
                    </SidebarSection>
                </>
            )}

            <StorageUsage className="mt-auto" condensed={condensed} />

            <DriveCreateEigenDoc
                open={createOpen}
                onOpenChange={setCreateOpen}
                type={config.createType}
                defaultOwnerId={rootPath?.ownerId}
                defaultFolderId={rootPath?.id}
                defaultMountId={rootPath?.mountId}
            />
        </div>
    );
}
