import { useAuth } from '@workspace/lib/auth';
import { DEFAULT_MOUNT_ID, useListTrash } from '@workspace/lib/drive';
import { useMyTeams } from '@workspace/lib/home';
import { teamOwnerId } from '@workspace/lib/types';
import type { DrivePath } from '@workspace/lib/types/drive';
import { SidebarItem, StorageUsage, UserAvatar } from '@workspace/ui';
import { Badge } from '@workspace/ui/components/badge';
import { SidebarHeader } from '@workspace/ui/components/layout/sidebar/sidebar-header';
import { SidebarSection } from '@workspace/ui/components/layout/sidebar/sidebar-section';
import { Separator } from '@workspace/ui/components/separator';
import {
    Download,
    FileText,
    Home,
    Image,
    MessageSquare,
    Presentation,
    Sheet,
    SquareKanban,
    Trash2,
    UsersRound,
} from 'lucide-react';
import { DriveNewMenu } from './drive-new-menu';

type DriveSidebarProps = {
    condensed?: boolean;
    onClose?: () => void;
    isMobile?: boolean;
    rootPath: DrivePath | null;
};

function TeamMountItem({
    ownerId,
    mountId,
    rootPathId,
    label,
    icon,
    condensed,
}: {
    ownerId: string;
    mountId: string;
    rootPathId: string | null;
    label: string;
    icon: React.ReactNode;
    condensed: boolean;
}) {
    if (!rootPathId) return null;
    return (
        <SidebarItem icon={icon} to={`/fs/${ownerId}/${mountId}/${rootPathId}`} label={label} condensed={condensed} />
    );
}

export function GuestDriveSidebar({
    condensed = false,
    onClose,
    isMobile = false,
}: Omit<DriveSidebarProps, 'rootPath'>) {
    return (
        <div className="flex h-full min-h-[calc(100vh-3.5rem)] flex-col">
            {isMobile && <SidebarHeader appName="drive" onClose={onClose} />}
            <SidebarSection condensed={condensed}>
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

export function DriveSidebar({ condensed = false, onClose, isMobile = false, rootPath }: DriveSidebarProps) {
    const auth = useAuth();
    const currentUserId = auth.user?.id || '';
    const { data: trashedItems } = useListTrash(currentUserId, DEFAULT_MOUNT_ID);
    const trashCount = trashedItems?.length ?? 0;

    const { data: myTeams } = useMyTeams();

    return (
        <div className="flex h-full min-h-[calc(100vh-3.5rem)] flex-col">
            {isMobile && <SidebarHeader appName="drive" onClose={onClose} />}
            <DriveNewMenu rootPath={rootPath} condensed={condensed} />

            <SidebarSection condensed={condensed}>
                <SidebarItem
                    icon={<Home className="h-4 w-4" />}
                    to={rootPath ? `/fs/${rootPath.ownerId}/${rootPath.mountId}/${rootPath.id}` : '/'}
                    label="Drive"
                    condensed={condensed}
                />
            </SidebarSection>
            <Separator />
            <SidebarSection condensed={condensed} title={condensed ? undefined : 'Filters'}>
                <SidebarItem
                    icon={<Image className="h-4 w-4" />}
                    to="/mime/image"
                    label="All images"
                    condensed={condensed}
                />
                <SidebarItem
                    icon={<FileText className="h-4 w-4" />}
                    to="/mime/application-eigendoc"
                    label="All docs"
                    condensed={condensed}
                />
                <SidebarItem
                    icon={<SquareKanban className="h-4 w-4" />}
                    to="/mime/application-eigenstickies"
                    label="All stickies"
                    condensed={condensed}
                />
                <SidebarItem
                    icon={<MessageSquare className="h-4 w-4" />}
                    to="/mime/application-eigenchat"
                    label="All chats"
                    condensed={condensed}
                />
                <SidebarItem
                    icon={<Presentation className="h-4 w-4" />}
                    to="/mime/application-eigenslides"
                    label="All slides"
                    condensed={condensed}
                />
                <SidebarItem
                    icon={<Sheet className="h-4 w-4" />}
                    to="/mime/application-eigensheets"
                    label="All sheets"
                    condensed={condensed}
                />
            </SidebarSection>
            <Separator />
            <SidebarSection condensed={condensed} title={condensed ? undefined : 'Sharing'}>
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
            <Separator />
            <SidebarSection condensed={condensed}>
                <SidebarItem icon={<Trash2 className="h-4 w-4" />} to="/trash" label="Trash" condensed={condensed}>
                    {!condensed && trashCount > 0 && (
                        <Badge variant="secondary" className="ml-auto text-xs">
                            {trashCount}
                        </Badge>
                    )}
                </SidebarItem>
            </SidebarSection>

            {myTeams?.some((t) => t.mounts.length > 0) && (
                <>
                    <Separator />
                    <SidebarSection condensed={condensed} title={condensed ? undefined : 'Team Drives'}>
                        {myTeams.flatMap((team) =>
                            team.mounts.map((mount) => (
                                <TeamMountItem
                                    key={`${team.id}-${mount.id}`}
                                    ownerId={teamOwnerId(team.id)}
                                    mountId={mount.id}
                                    rootPathId={mount.rootPathId}
                                    label={mount.name}
                                    icon={<UserAvatar email={teamOwnerId(team.id)} className="h-4 w-4" />}
                                    condensed={condensed}
                                />
                            )),
                        )}
                    </SidebarSection>
                </>
            )}

            <StorageUsage className="mt-auto" condensed={condensed} />
        </div>
    );
}
