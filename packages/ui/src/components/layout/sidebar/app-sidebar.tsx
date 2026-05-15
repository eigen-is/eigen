import { getDocsAppUrl, getDriveAppUrl, getSheetsAppUrl, getSlidesAppUrl, getStickiesAppUrl } from '@workspace/lib/api';
import { useAuth, useIsGuest } from '@workspace/lib/auth';
import { DEFAULT_MOUNT_ID, useListTrash, useRootFolder } from '@workspace/lib/drive';
import { useMyTeams } from '@workspace/lib/home';
import { teamOwnerId } from '@workspace/lib/types';
import type { DrivePath } from '@workspace/lib/types/drive';
import { Badge } from '@workspace/ui/components/badge';
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
import type { ReactNode } from 'react';
import { useLayout } from '../app/layout-context';
import { StorageUsage } from '../home/usage';
import { UserAvatar } from '../user-avatar';
import { SidebarHeader } from './sidebar-header';
import { SidebarItem } from './sidebar-item';
import { SidebarSection } from './sidebar-section';

type AppSidebarProps = {
    condensed?: boolean;
    isMobile?: boolean;
    onClose?: () => void;
    newButton?: ReactNode;
};

type FilterApp = 'drive' | 'docs' | 'slides' | 'stickies' | 'sheets';

type FilterEntry = {
    targetApp: FilterApp;
    label: string;
    icon: ReactNode;
    driveMime: string;
    appHref: () => string;
};

const FILTER_ENTRIES: ReadonlyArray<FilterEntry> = [
    {
        targetApp: 'drive',
        label: 'All images',
        icon: <Image className="h-4 w-4" />,
        driveMime: 'image',
        appHref: () => getDriveAppUrl('mime/image'),
    },
    {
        targetApp: 'docs',
        label: 'All docs',
        icon: <FileText className="h-4 w-4" />,
        driveMime: 'application-eigendoc',
        appHref: () => getDocsAppUrl(),
    },
    {
        targetApp: 'stickies',
        label: 'All stickies',
        icon: <SquareKanban className="h-4 w-4" />,
        driveMime: 'application-eigenstickies',
        appHref: () => getStickiesAppUrl(),
    },
    {
        targetApp: 'drive',
        label: 'All chats',
        icon: <MessageSquare className="h-4 w-4" />,
        driveMime: 'application-eigenchat',
        appHref: () => getDriveAppUrl('mime/application-eigenchat'),
    },
    {
        targetApp: 'slides',
        label: 'All slides',
        icon: <Presentation className="h-4 w-4" />,
        driveMime: 'application-eigenslides',
        appHref: () => getSlidesAppUrl(),
    },
    {
        targetApp: 'sheets',
        label: 'All sheets',
        icon: <Sheet className="h-4 w-4" />,
        driveMime: 'application-eigensheets',
        appHref: () => getSheetsAppUrl(),
    },
];

function isFilterApp(name: string): name is FilterApp {
    return name === 'drive' || name === 'docs' || name === 'slides' || name === 'stickies' || name === 'sheets';
}

const SHARING_NOUN: Record<Exclude<FilterApp, 'drive'>, string> = {
    docs: 'Docs',
    slides: 'Slides',
    stickies: 'Stickies',
    sheets: 'Sheets',
};

function sharingLabel(direction: 'by-me' | 'with-me', currentApp: FilterApp): string {
    const base = direction === 'by-me' ? 'Shared by me' : 'Shared with me';
    if (currentApp === 'drive') return base;
    return `${SHARING_NOUN[currentApp]} ${base.toLowerCase()}`;
}

function FilterRow({
    entry,
    currentApp,
    condensed,
}: {
    entry: FilterEntry;
    currentApp: FilterApp;
    condensed: boolean;
}) {
    if (entry.targetApp === currentApp) {
        const to = currentApp === 'drive' ? `/mime/${entry.driveMime}` : '/';
        return <SidebarItem icon={entry.icon} to={to} label={entry.label} condensed={condensed} exact={to === '/'} />;
    }
    return <SidebarItem icon={entry.icon} href={entry.appHref()} label={entry.label} condensed={condensed} />;
}

function GuestAppSidebar({
    currentApp,
    condensed,
    isMobile,
    onClose,
}: {
    currentApp: string;
    condensed: boolean;
    isMobile: boolean;
    onClose?: () => void;
}) {
    return (
        <div className="flex h-full min-h-[calc(100vh-3.5rem)] flex-col">
            {isMobile && <SidebarHeader appName={currentApp} onClose={onClose} />}
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

export function AppSidebar({ condensed = false, isMobile = false, onClose, newButton }: AppSidebarProps) {
    const { appName } = useLayout();
    const isGuest = useIsGuest();
    const { user } = useAuth();

    if (isGuest) {
        return <GuestAppSidebar currentApp={appName} condensed={condensed} isMobile={isMobile} onClose={onClose} />;
    }

    const currentApp: FilterApp = isFilterApp(appName) ? appName : 'drive';
    const userId = user?.id || '';
    const { data: ownRoot } = useRootFolder(userId, DEFAULT_MOUNT_ID);
    const personalRoot: DrivePath | null = ownRoot || null;

    const { data: trashedItems } = useListTrash(currentApp === 'drive' ? userId : '', DEFAULT_MOUNT_ID);
    const trashCount = trashedItems?.length ?? 0;

    const { data: myTeams } = useMyTeams();

    const driveHomePath = personalRoot ? `/fs/${personalRoot.ownerId}/${personalRoot.mountId}/${personalRoot.id}` : '/';
    const driveHomeHref = personalRoot ? getDriveAppUrl(driveHomePath.slice(1)) : getDriveAppUrl();

    return (
        <div className="flex h-full min-h-[calc(100vh-3.5rem)] flex-col">
            {isMobile && <SidebarHeader appName={appName} onClose={onClose} />}
            {newButton}

            <SidebarSection condensed={condensed}>
                {currentApp === 'drive' ? (
                    <SidebarItem
                        icon={<Home className="h-4 w-4" />}
                        to={driveHomePath}
                        label="Drive"
                        condensed={condensed}
                    />
                ) : (
                    <SidebarItem
                        icon={<Home className="h-4 w-4" />}
                        href={driveHomeHref}
                        label="Drive"
                        condensed={condensed}
                    />
                )}
            </SidebarSection>

            <Separator />
            <SidebarSection condensed={condensed} title={condensed ? undefined : 'Filters'}>
                {FILTER_ENTRIES.map((entry) => (
                    <FilterRow key={entry.label} entry={entry} currentApp={currentApp} condensed={condensed} />
                ))}
            </SidebarSection>

            <Separator />
            <SidebarSection condensed={condensed} title={condensed ? undefined : 'Sharing'}>
                <SidebarItem
                    icon={<UsersRound className="h-4 w-4" />}
                    to="/shared/by-me"
                    label={sharingLabel('by-me', currentApp)}
                    condensed={condensed}
                />
                <SidebarItem
                    icon={<Download className="h-4 w-4" />}
                    to="/shared/with-me"
                    label={sharingLabel('with-me', currentApp)}
                    condensed={condensed}
                />
            </SidebarSection>

            <Separator />
            <SidebarSection condensed={condensed}>
                {currentApp === 'drive' ? (
                    <SidebarItem icon={<Trash2 className="h-4 w-4" />} to="/trash" label="Trash" condensed={condensed}>
                        {!condensed && trashCount > 0 && (
                            <Badge variant="secondary" className="ml-auto text-xs">
                                {trashCount}
                            </Badge>
                        )}
                    </SidebarItem>
                ) : (
                    <SidebarItem
                        icon={<Trash2 className="h-4 w-4" />}
                        href={getDriveAppUrl('trash')}
                        label="Trash"
                        condensed={condensed}
                    />
                )}
            </SidebarSection>

            {myTeams?.some((t) => t.mounts.length > 0) && (
                <>
                    <Separator />
                    <SidebarSection condensed={condensed} title={condensed ? undefined : 'Team Drives'}>
                        {myTeams.flatMap((team) =>
                            team.mounts
                                .filter((mount) => mount.rootPathId)
                                .map((mount) => {
                                    const owner = teamOwnerId(team.id);
                                    const to =
                                        currentApp === 'drive'
                                            ? `/fs/${owner}/${mount.id}/${mount.rootPathId}`
                                            : `/drive/${owner}/${mount.id}`;
                                    return (
                                        <SidebarItem
                                            key={`${team.id}-${mount.id}`}
                                            icon={<UserAvatar email={owner} className="h-4 w-4" />}
                                            to={to}
                                            label={mount.name}
                                            condensed={condensed}
                                        />
                                    );
                                }),
                        )}
                    </SidebarSection>
                </>
            )}

            <StorageUsage className="mt-auto" condensed={condensed} />
        </div>
    );
}
