import {
    getDocsAppUrl,
    getDriveAppUrl,
    getSheetsAppUrl,
    getSlidesAppUrl,
    getStickiesAppUrl,
    getVectorAppUrl,
} from '@workspace/lib/api';
import { useAuth, useIsGuest } from '@workspace/lib/auth';
import { DEFAULT_MOUNT_ID, useListTrash, useRootFolder } from '@workspace/lib/drive';
import { useMyTeams } from '@workspace/lib/home';
import { teamOwnerId } from '@workspace/lib/types';
import { Badge } from '@workspace/ui/components/badge';
import {
    Bell,
    Diamond,
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
import { StorageUsage } from '../../home/usage';
import { UserAvatar } from '../../user/user-avatar';
import { useLayout } from '../app/layout-context';
import { SidebarBody } from './sidebar-body';
import { SidebarItem } from './sidebar-item';
import { SidebarSection } from './sidebar-section';

type AppSidebarProps = {
    condensed?: boolean;
    newButton?: ReactNode;
};

type FilterApp = 'drive' | 'docs' | 'slides' | 'stickies' | 'sheets' | 'vector';

type FilterEntry = {
    targetApp: FilterApp;
    label: string;
    icon: ReactNode;
    driveMime: string;
    appHref: () => string;
};

// Not derived from EIGENDOC_CONFIGS or apps.ts: this list includes Drive-internal rows
// (All images, All chats — no dedicated app) alongside app-backed rows, and the display
// order matches the routing matrix in the design spec.
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
    {
        targetApp: 'vector',
        label: 'All vectors',
        icon: <Diamond className="h-4 w-4" />,
        driveMime: 'application-eigenvector',
        appHref: () => getVectorAppUrl(),
    },
];

// Drive mime slug (`image`, `application-eigenstickies`) → sidebar filter label,
// so a filter view's toolbar title matches its nav entry exactly.
export const FILTER_LABELS: Record<string, string> = Object.fromEntries(
    FILTER_ENTRIES.map((entry) => [entry.driveMime, entry.label]),
);

function isFilterApp(name: string): name is FilterApp {
    return (
        name === 'drive' ||
        name === 'docs' ||
        name === 'slides' ||
        name === 'stickies' ||
        name === 'sheets' ||
        name === 'vector'
    );
}

const SHARING_NOUN: Record<Exclude<FilterApp, 'drive'>, string> = {
    docs: 'Docs',
    slides: 'Slides',
    stickies: 'Stickies',
    sheets: 'Sheets',
    vector: 'Vectors',
};

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

function GuestAppSidebar({ condensed }: { condensed: boolean }) {
    return (
        <SidebarBody>
            <SidebarSection condensed={condensed}>
                <SidebarItem
                    icon={<Download className="h-4 w-4" />}
                    to="/shared/with-me"
                    label="Shared with me"
                    condensed={condensed}
                />
            </SidebarSection>
        </SidebarBody>
    );
}

export function AppSidebar({ condensed = false, newButton }: AppSidebarProps) {
    const isGuest = useIsGuest();
    if (isGuest) {
        return <GuestAppSidebar condensed={condensed} />;
    }
    return <UserAppSidebar condensed={condensed} newButton={newButton} />;
}

// Split from AppSidebar so its hooks sit under the guest fork without breaking hook order.
function UserAppSidebar({ condensed = false, newButton }: AppSidebarProps) {
    const { appName } = useLayout();
    const { user } = useAuth();

    const currentApp: FilterApp = isFilterApp(appName) ? appName : 'drive';
    const userId = user!.id;
    const { data: ownRoot } = useRootFolder(userId, DEFAULT_MOUNT_ID);
    const personalRoot = ownRoot ?? null;

    // Empty ownerId short-circuits the hook's enabled guard; only fetch trash count in Drive.
    const { data: trashedItems } = useListTrash(currentApp === 'drive' ? userId : '', DEFAULT_MOUNT_ID);
    const trashCount = trashedItems?.length ?? 0;

    const { data: myTeams } = useMyTeams();

    const driveHomePath = personalRoot ? `fs/${personalRoot.ownerId}/${personalRoot.mountId}/${personalRoot.id}` : '';
    const driveHomeProps =
        currentApp === 'drive'
            ? { to: driveHomePath ? `/${driveHomePath}` : '/' }
            : { href: getDriveAppUrl(driveHomePath) };
    const trashProps = currentApp === 'drive' ? { to: '/trash' } : { href: getDriveAppUrl('trash') };
    const watchedProps = currentApp === 'drive' ? { to: '/watched' } : { href: getDriveAppUrl('watched') };

    return (
        <SidebarBody>
            {newButton}

            <SidebarSection condensed={condensed}>
                <SidebarItem
                    icon={<Home className="h-4 w-4" />}
                    {...driveHomeProps}
                    label="Drive"
                    condensed={condensed}
                />
            </SidebarSection>

            <SidebarSection condensed={condensed} title={condensed ? undefined : 'Filters'}>
                {FILTER_ENTRIES.map((entry) => (
                    <FilterRow key={entry.label} entry={entry} currentApp={currentApp} condensed={condensed} />
                ))}
            </SidebarSection>

            <SidebarSection condensed={condensed} title={condensed ? undefined : 'Sharing'}>
                <SidebarItem
                    icon={<UsersRound className="h-4 w-4" />}
                    to="/shared/by-me"
                    label={currentApp === 'drive' ? 'Shared by me' : `${SHARING_NOUN[currentApp]} shared by me`}
                    condensed={condensed}
                />
                <SidebarItem
                    icon={<Download className="h-4 w-4" />}
                    to="/shared/with-me"
                    label={currentApp === 'drive' ? 'Shared with me' : `${SHARING_NOUN[currentApp]} shared with me`}
                    condensed={condensed}
                />
                <SidebarItem
                    icon={<Bell className="h-4 w-4" />}
                    {...watchedProps}
                    label="Watched"
                    condensed={condensed}
                />
            </SidebarSection>

            <SidebarSection condensed={condensed}>
                <SidebarItem icon={<Trash2 className="h-4 w-4" />} {...trashProps} label="Trash" condensed={condensed}>
                    {currentApp === 'drive' && !condensed && trashCount > 0 && (
                        <Badge variant="secondary" className="ml-auto text-xs">
                            {trashCount}
                        </Badge>
                    )}
                </SidebarItem>
            </SidebarSection>

            {myTeams?.some((t) => t.mounts.length > 0) && (
                <SidebarSection condensed={condensed} title={condensed ? undefined : 'Team Drives'}>
                    {myTeams.flatMap((team) =>
                        team.mounts
                            .filter((mount) => mount.rootPathId)
                            .map((mount) => {
                                const owner = teamOwnerId(team.id);
                                // A team drive always opens its folder view — in Drive directly, from
                                // an eigendoc app over in the Drive app (like the Drive home link). The
                                // type-filtered slice already lives in this app's "All …" view.
                                const fsPath = `fs/${owner}/${mount.id}/${mount.rootPathId}`;
                                const mountProps =
                                    currentApp === 'drive' ? { to: `/${fsPath}` } : { href: getDriveAppUrl(fsPath) };
                                return (
                                    <SidebarItem
                                        key={`${team.id}-${mount.id}`}
                                        icon={<UserAvatar email={owner} className="h-4 w-4" />}
                                        {...mountProps}
                                        label={mount.name}
                                        condensed={condensed}
                                    />
                                );
                            }),
                    )}
                </SidebarSection>
            )}

            <StorageUsage className="mt-auto" condensed={condensed} />
        </SidebarBody>
    );
}
