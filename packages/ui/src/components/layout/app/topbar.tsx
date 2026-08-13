import { useRouter } from '@tanstack/react-router';
import { useIsAdmin } from '@workspace/lib/admin';
import { getAdminAppUrl, getSpacePasswordUrl, getSpaceProfileUrl, getSupportUrl } from '@workspace/lib/api';
import { apps } from '@workspace/lib/apps';
import { useAuth, useIsGuest } from '@workspace/lib/auth';
import { useUnreadNotificationCount } from '@workspace/lib/notification';
import { useSpaceSettings, useUpdateSpaceSettings } from '@workspace/lib/space';
import { cn } from '@workspace/ui/lib/utils';
import { Grip, LifeBuoy, LogOut, Palette, Settings, Shield, UserRound } from 'lucide-react';
import { useEffect, useState } from 'react';
import { EigenLogo } from '../../braket/eigen-logo';
import { Button } from '../../button';
import { ConfirmDialog } from '../../confirm-dialog';
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuLabel,
    DropdownMenuRadioGroup,
    DropdownMenuRadioItem,
    DropdownMenuSeparator,
    DropdownMenuSub,
    DropdownMenuSubContent,
    DropdownMenuSubTrigger,
    DropdownMenuTrigger,
} from '../../dropdown-menu';
import { UserAvatar } from '../../user/user-avatar';
import { UserItem } from '../../user/user-item';
import { AboutDialog } from './about-dialog';
import { AppLogo } from './app-logo';
import { CommandPaletteTrigger } from './command-palette/command-palette-trigger';
import { useLayout } from './layout-context';
import { NotificationBell } from './notification-bell';

type NavigateFunction = (opts: { to: string }) => unknown;

type TopbarProps = {
    rootRoute: {
        useNavigate: () => NavigateFunction;
    };
};

const GUEST_APPS = new Set(['Drive', 'Docs', 'Stickies', 'Slides', 'Sheets', 'Chat']);

function LogoutDialog({
    open,
    onOpenChange,
    onLogout,
}: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    onLogout: () => void;
}) {
    return (
        <ConfirmDialog
            open={open}
            onOpenChange={onOpenChange}
            title="Log out?"
            description="Logging out will end your current session. You will be logged out of your account and will need to log in again to continue."
            cancelText="Go Back"
            confirmText="Log Out"
            onConfirm={onLogout}
        />
    );
}

function useLogout(rootRoute: TopbarProps['rootRoute']) {
    const router = useRouter();
    const navigate = rootRoute.useNavigate();
    const auth = useAuth();
    const [logoutDialogOpen, setLogoutDialogOpen] = useState(false);

    const handleLogout = () => {
        auth.logout().then(() => {
            router.invalidate().finally(() => {
                navigate({ to: '/' });
                setLogoutDialogOpen(false);
            });
        });
    };

    return { logoutDialogOpen, setLogoutDialogOpen, handleLogout };
}

function AppSwitcher({ isGuest }: { isGuest: boolean }) {
    const { appName } = useLayout();
    const isAdmin = useIsAdmin();
    const appList = isGuest ? apps.filter((app) => GUEST_APPS.has(app.name)) : apps;

    return (
        <DropdownMenu>
            <DropdownMenuTrigger asChild>
                <Button
                    variant="ghost"
                    size="icon"
                    aria-label="Switch app"
                    className="mr-1 h-8 w-8 text-[var(--topbar-icon)] hover:bg-[var(--topbar-icon-hover-bg)] hover:text-[var(--topbar-icon-hover-fg)]"
                >
                    <Grip className="h-5 w-5" />
                </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent className="min-w-56 p-3" align="start" forceMount>
                <div className="grid grid-cols-3 w-full gap-2">
                    {appList.map((app) => {
                        const isActive = app.name.toLowerCase() === appName.toLowerCase();
                        const Icon = app.icon;
                        return (
                            <DropdownMenuItem
                                key={app.name}
                                asChild
                                className={cn(
                                    'px-3 py-3 border rounded-md flex flex-col items-center gap-1.5 w-full text-sm',
                                    isActive ? 'bg-muted font-medium' : '',
                                )}
                            >
                                <a href={app.href}>
                                    <Icon className="size-4.5" style={{ color: app.color }} />
                                    {app.name}
                                </a>
                            </DropdownMenuItem>
                        );
                    })}
                </div>

                {isAdmin && !isGuest && (
                    <div className="border-t pt-3 mt-3">
                        <DropdownMenuItem asChild>
                            <a href={getAdminAppUrl()}>
                                <Shield className="size-4.5" />
                                Admin
                            </a>
                        </DropdownMenuItem>
                    </div>
                )}
            </DropdownMenuContent>
        </DropdownMenu>
    );
}

function GuestUserDropdown({ rootRoute }: { rootRoute: TopbarProps['rootRoute'] }) {
    const auth = useAuth();
    const { logoutDialogOpen, setLogoutDialogOpen, handleLogout } = useLogout(rootRoute);
    const [aboutOpen, setAboutOpen] = useState(false);

    if (!auth.isAuthenticated) return null;

    return (
        <>
            <LogoutDialog open={logoutDialogOpen} onOpenChange={setLogoutDialogOpen} onLogout={handleLogout} />
            <AboutDialog open={aboutOpen} onOpenChange={setAboutOpen} />
            <DropdownMenu>
                <DropdownMenuTrigger asChild>
                    <Button variant="ghost" className="relative h-8 w-8 rounded-full overflow-hidden p-0">
                        <UserAvatar
                            name={auth.user?.name}
                            email={auth.user?.email}
                            userId={auth.user?.email}
                            size="sm"
                        />
                    </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent className="w-56" align="end" forceMount>
                    <DropdownMenuLabel className="font-normal">
                        <UserItem name={auth.user?.name} email={auth.user?.email} className="p-0" />
                    </DropdownMenuLabel>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem asChild>
                        <a href={getSupportUrl()}>
                            <LifeBuoy />
                            Support
                        </a>
                    </DropdownMenuItem>
                    <DropdownMenuItem onClick={() => setAboutOpen(true)}>
                        <EigenLogo />
                        About Eigen
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem onClick={() => setLogoutDialogOpen(true)}>
                        <LogOut />
                        Log out
                    </DropdownMenuItem>
                </DropdownMenuContent>
            </DropdownMenu>
        </>
    );
}

function UserDropdown({ rootRoute }: { rootRoute: TopbarProps['rootRoute'] }) {
    const auth = useAuth();
    const { logoutDialogOpen, setLogoutDialogOpen, handleLogout } = useLogout(rootRoute);
    const { data: settings } = useSpaceSettings();
    const updateSettings = useUpdateSpaceSettings();
    const [aboutOpen, setAboutOpen] = useState(false);

    if (!auth.isAuthenticated) return null;

    return (
        <>
            <LogoutDialog open={logoutDialogOpen} onOpenChange={setLogoutDialogOpen} onLogout={handleLogout} />
            <AboutDialog open={aboutOpen} onOpenChange={setAboutOpen} />
            <DropdownMenu>
                <DropdownMenuTrigger asChild>
                    <Button variant="ghost" className="relative h-8 w-8 rounded-full overflow-hidden p-0">
                        <UserAvatar
                            name={auth.user?.name}
                            email={auth.user?.email}
                            userId={auth.user?.email}
                            size="sm"
                        />
                    </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent className="w-56" align="end" forceMount>
                    <DropdownMenuLabel className="font-normal">
                        <UserItem name={auth.user?.name} email={auth.user?.email} className="p-0" />
                    </DropdownMenuLabel>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem asChild>
                        <a href={getSpaceProfileUrl()}>
                            <UserRound />
                            Profile
                        </a>
                    </DropdownMenuItem>
                    <DropdownMenuItem asChild>
                        <a href={getSpacePasswordUrl()}>
                            <Settings />
                            Settings
                        </a>
                    </DropdownMenuItem>
                    <DropdownMenuSub>
                        <DropdownMenuSubTrigger>
                            <Palette />
                            Theme
                        </DropdownMenuSubTrigger>
                        <DropdownMenuSubContent>
                            <DropdownMenuRadioGroup
                                value={settings?.theme ?? 'light'}
                                onValueChange={(v) =>
                                    updateSettings.mutate({ theme: v as 'light' | 'dark' | 'system' })
                                }
                            >
                                <DropdownMenuRadioItem value="light">Light</DropdownMenuRadioItem>
                                <DropdownMenuRadioItem value="dark">Dark</DropdownMenuRadioItem>
                                <DropdownMenuRadioItem value="system">System</DropdownMenuRadioItem>
                            </DropdownMenuRadioGroup>
                        </DropdownMenuSubContent>
                    </DropdownMenuSub>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem asChild>
                        <a href={getSupportUrl()}>
                            <LifeBuoy />
                            Support
                        </a>
                    </DropdownMenuItem>
                    <DropdownMenuItem onClick={() => setAboutOpen(true)}>
                        <EigenLogo />
                        About Eigen
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem onClick={() => setLogoutDialogOpen(true)}>
                        <LogOut />
                        Log out
                    </DropdownMenuItem>
                </DropdownMenuContent>
            </DropdownMenu>
        </>
    );
}

export function Topbar({ rootRoute }: TopbarProps) {
    const { appName, documentTitle, isMobile } = useLayout();
    const auth = useAuth();
    const isGuest = useIsGuest();
    const { data: unreadCount = 0 } = useUnreadNotificationCount(auth.user?.id ?? '');

    useEffect(() => {
        const base = documentTitle ? `${documentTitle} — eigen|${appName}>` : `eigen|${appName}>`;
        document.title = unreadCount > 0 ? `(${unreadCount}) ${base}` : base;
    }, [appName, documentTitle, unreadCount]);

    return (
        <header
            className="border-b shrink-0"
            style={{ backgroundColor: 'var(--topbar-bg)', borderColor: 'var(--topbar-border)' }}
        >
            {/* 1fr·auto·1fr grid keeps the title / command palette at the bar's true
                center, independent of the left (logo) and right (actions) block widths */}
            <div className="grid h-12 items-center" style={{ gridTemplateColumns: '1fr auto 1fr' }}>
                <div className="flex items-center pl-2 pr-4">
                    {auth.isAuthenticated ? (
                        <AppSwitcher isGuest={isGuest} />
                    ) : (
                        <div className="mr-1 flex h-8 w-8 items-center justify-center text-[var(--topbar-icon)]">
                            <EigenLogo className="h-5 w-5" />
                        </div>
                    )}
                    <AppLogo appName={appName.toLowerCase()} />
                </div>

                <div className="flex justify-center min-w-0">
                    {!isMobile && auth.isAuthenticated && <CommandPaletteTrigger documentTitle={documentTitle} />}
                </div>

                <div className="flex items-center justify-end gap-1 px-4">
                    {isMobile && auth.isAuthenticated && <CommandPaletteTrigger />}
                    <NotificationBell />
                    {isGuest ? <GuestUserDropdown rootRoute={rootRoute} /> : <UserDropdown rootRoute={rootRoute} />}
                </div>
            </div>
        </header>
    );
}
