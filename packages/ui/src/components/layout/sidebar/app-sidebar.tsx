import { getDriveAppUrl } from '@workspace/lib/api';
import { useAuth, useIsGuest } from '@workspace/lib/auth';
import { DEFAULT_MOUNT_ID, useListTrash, useRootFolder } from '@workspace/lib/drive';
import { useMyTeams } from '@workspace/lib/home';
import { teamOwnerId } from '@workspace/lib/types';
import type { EigenDocType } from '@workspace/lib/types/drive';
import { Badge } from '@workspace/ui/components/badge';
import { Bell, Download, Home, Image, type LucideIcon, Trash2, UsersRound } from 'lucide-react';
import type { ReactNode } from 'react';
import { EIGEN_DOC_APP_CONFIGS, type EigenDocAppConfig, eigenDocSharedTitle } from '../../drive/eigendoc-config';
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

type FilterEntry = {
    // The eigendoc app that hosts this row's list view, or null when Drive hosts it
    // (All images, All chats).
    hostApp: EigenDocType | null;
    label: string;
    icon: LucideIcon;
    driveMime: string;
    appHref: () => string;
};

// "All images" is the one row with no EigenDocType — it filters by mime category, not by
// container type. The rest come straight off the shared per-app configs, nav order and all.
const FILTER_ENTRIES: ReadonlyArray<FilterEntry> = [
    {
        hostApp: null,
        label: 'All images',
        icon: Image,
        driveMime: 'image',
        appHref: () => getDriveAppUrl('mime/image'),
    },
    ...EIGEN_DOC_APP_CONFIGS.map(
        (config): FilterEntry => ({
            hostApp: config.appUrl ? config.type : null,
            label: config.allLabel,
            icon: config.icon,
            driveMime: config.mimeType,
            appHref: config.appUrl ?? (() => getDriveAppUrl(`mime/${config.mimeType}`)),
        }),
    ),
];

// Drive mime slug (`image`, `application-eigenstickies`) → sidebar filter label,
// so a filter view's toolbar title matches its nav entry exactly.
export const FILTER_LABELS: Record<string, string> = Object.fromEntries(
    FILTER_ENTRIES.map((entry) => [entry.driveMime, entry.label]),
);

// The eigendoc app we're rendering inside, or null in Drive — and in any app without a
// filter view of its own, which then gets Drive's own rows and links.
function currentHostConfig(appName: string): EigenDocAppConfig | null {
    return EIGEN_DOC_APP_CONFIGS.find((config) => config.appUrl && config.appName === appName) ?? null;
}

function FilterRow({
    entry,
    hostApp,
    condensed,
}: {
    entry: FilterEntry;
    hostApp: EigenDocType | null;
    condensed: boolean;
}) {
    const icon = <entry.icon className="h-4 w-4" />;
    if (entry.hostApp === hostApp) {
        const to = hostApp === null ? `/mime/${entry.driveMime}` : '/';
        return <SidebarItem icon={icon} to={to} label={entry.label} condensed={condensed} exact={to === '/'} />;
    }
    return <SidebarItem icon={icon} href={entry.appHref()} label={entry.label} condensed={condensed} />;
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

    const host = currentHostConfig(appName);
    const inDrive = host === null;
    const userId = user!.id;
    const { data: ownRoot } = useRootFolder(userId, DEFAULT_MOUNT_ID);
    const personalRoot = ownRoot ?? null;

    // Empty ownerId short-circuits the hook's enabled guard; only fetch trash count in Drive.
    const { data: trashedItems } = useListTrash(inDrive ? userId : '', DEFAULT_MOUNT_ID);
    const trashCount = trashedItems?.length ?? 0;

    const { data: myTeams } = useMyTeams();

    const driveHomePath = personalRoot ? `fs/${personalRoot.ownerId}/${personalRoot.mountId}/${personalRoot.id}` : '';
    const driveHomeProps = inDrive
        ? { to: driveHomePath ? `/${driveHomePath}` : '/' }
        : { href: getDriveAppUrl(driveHomePath) };
    const trashProps = inDrive ? { to: '/trash' } : { href: getDriveAppUrl('trash') };
    const watchedProps = inDrive ? { to: '/watched' } : { href: getDriveAppUrl('watched') };

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
                    <FilterRow key={entry.label} entry={entry} hostApp={host?.type ?? null} condensed={condensed} />
                ))}
            </SidebarSection>

            <SidebarSection condensed={condensed} title={condensed ? undefined : 'Sharing'}>
                <SidebarItem
                    icon={<UsersRound className="h-4 w-4" />}
                    to="/shared/by-me"
                    label={eigenDocSharedTitle('by', host?.labelPlural)}
                    condensed={condensed}
                />
                <SidebarItem
                    icon={<Download className="h-4 w-4" />}
                    to="/shared/with-me"
                    label={eigenDocSharedTitle('with', host?.labelPlural)}
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
                    {inDrive && !condensed && trashCount > 0 && (
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
                                const mountProps = inDrive ? { to: `/${fsPath}` } : { href: getDriveAppUrl(fsPath) };
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
