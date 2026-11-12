// The sidebar of Drive and the document apps: the New button, the Drive and Recent files rows, a filter row per kind
// of file, such as All images, the sharing pages and the team drives. A guest sees only what was shared with them.

import { getDriveAppUrl } from '@workspace/lib/api';
import type { AuthUser } from '@workspace/lib/auth';
import { useAuth, useIsGuest } from '@workspace/lib/auth';
import { DEFAULT_MOUNT_ID, useRootFolder, useTrash } from '@workspace/lib/drive';
import { useMyTeams } from '@workspace/lib/home';
import { teamOwnerId } from '@workspace/lib/types';
import type { EigenDocType } from '@workspace/lib/types/drive';
import { Badge } from '@workspace/ui/components/badge';
import type { LucideIcon } from 'lucide-react';
import { Bell, Download, Home, Image, Trash2, UsersRound } from 'lucide-react';
import type { ReactNode } from 'react';
import type { EigenDocAppConfig } from '../../drive/eigendoc-config';
import { EIGEN_DOC_APP_CONFIGS, eigenDocSharedTitle } from '../../drive/eigendoc-config';
import { StorageUsage } from '../../home/usage';
import { UserAvatar } from '../../user/user-avatar';
import { useLayout } from '../app/layout-context';
import { RecentFilesSidebarItem } from './recent-files-sidebar-item';
import { SidebarBody } from './sidebar-body';
import { SidebarItem } from './sidebar-item';
import { SidebarSection } from './sidebar-section';

type AppSidebarProps = {
    condensed?: boolean;
    newButton?: ReactNode;
};

type FilterEntry = {
    // The eigendoc app that hosts this row's list view, or null when Drive hosts it, as for All images.
    hostApp: EigenDocType | null;
    label: string;
    icon: LucideIcon;
    driveMime: string;
    appHref: () => string;
};

// All images filters by a mime category rather than a document type, so it is the one row no app config gives.
const FILTER_ENTRIES: readonly FilterEntry[] = [
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

// The sidebar label per Drive mime slug, such as `image`, so a filter view's toolbar title matches its row.
export const FILTER_LABELS: Readonly<Record<string, string>> = Object.fromEntries(
    FILTER_ENTRIES.map((entry) => [entry.driveMime, entry.label]),
);

export function AppSidebar({ condensed = false, newButton }: AppSidebarProps) {
    const { user } = useAuth();
    const isGuest = useIsGuest();
    if (!user || isGuest) {
        return <GuestAppSidebar condensed={condensed} />;
    }
    return <UserAppSidebar user={user} condensed={condensed} newButton={newButton} />;
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

// Split from AppSidebar so its hooks sit under the guest fork without breaking hook order.
function UserAppSidebar({ user, condensed, newButton }: { user: AuthUser; condensed: boolean; newButton?: ReactNode }) {
    const { appName } = useLayout();

    const host = currentHostConfig(appName);
    const inDrive = host === null;
    const { data: personalRoot } = useRootFolder(user.id, DEFAULT_MOUNT_ID);

    // Only Drive shows the count, and without a viewer the hook reads no trash.
    const trashCount = useTrash(inDrive ? user.id : '').items.length;

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
                <RecentFilesSidebarItem inDrive={inDrive} condensed={condensed} />
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

            {myTeams?.some((team) => team.mounts.length > 0) && (
                <SidebarSection condensed={condensed} title={condensed ? undefined : 'Team drives'}>
                    {myTeams.flatMap((team) =>
                        team.mounts
                            .filter((mount) => mount.rootPathId)
                            .map((mount) => {
                                const owner = teamOwnerId(team.id);
                                // A team drive opens its folder view in Drive, even from a document app,
                                // whose own All view already lists that drive's files of its kind.
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

// The eigendoc app this sidebar renders in, or null in Drive and in any app without a filter view of its own, which
// then gets Drive's rows and links.
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
