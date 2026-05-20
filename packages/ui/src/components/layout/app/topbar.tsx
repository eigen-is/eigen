import { useRouter } from '@tanstack/react-router';
import { useIsAdmin } from '@workspace/lib/admin';
import { getAdminAppUrl, getSpacePasswordUrl, getSpaceProfileUrl, getSupportUrl } from '@workspace/lib/api.ts';
import { apps } from '@workspace/lib/apps.ts';
import { useAuth, useIsGuest } from '@workspace/lib/auth';
import { useUnreadNotificationCount } from '@workspace/lib/notification';
import { useSpaceSettings, useUpdateSpaceSettings } from '@workspace/lib/space';
import { Grip, LifeBuoy, LogOut, Menu, Palette, Settings, Shield, UserRound } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Button } from '../../button.tsx';
import { ConfirmDialog } from '../../confirm-dialog.tsx';
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
} from '../../dropdown-menu.tsx';
import { EigenLogo } from '../braket/eigen-logo.tsx';
import { UserAvatar } from '../user-avatar.tsx';
import { UserItem } from '../user-item.tsx';
import { AboutDialog } from './about-dialog.tsx';
import { AppLogo } from './app-logo.tsx';
import { useLayout } from './layout-context.tsx';
import { NotificationBell } from './notification-bell.tsx';

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
    const { appName, isMobile } = useLayout();
    const isAdmin = useIsAdmin();
    const appList = isGuest ? apps.filter((app) => GUEST_APPS.has(app.name)) : apps;

    return (
        <DropdownMenu>
            <DropdownMenuTrigger asChild>
                <Button
                    variant="ghost"
                    size="icon"
                    className="mr-1 h-8 w-8 text-white hover:bg-primary/20 hover:text-white"
                >
                    <Grip className="h-5 w-5" />
                </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent className="w-56" align={isMobile ? 'end' : 'start'} forceMount>
                {appList.map((app) => {
                    const isActive = app.name.toLowerCase() === appName.toLowerCase();
                    const Icon = app.icon;
                    return (
                        <DropdownMenuItem key={app.name} asChild className={isActive ? 'bg-muted font-medium' : ''}>
                            <a href={app.href}>
                                <Icon />
                                {app.name}
                            </a>
                        </DropdownMenuItem>
                    );
                })}
                {isAdmin && !isGuest && (
                    <>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem asChild>
                            <a href={getAdminAppUrl()}>
                                <Shield />
                                Admin
                            </a>
                        </DropdownMenuItem>
                    </>
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
                            Help
                        </a>
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
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
                    <DropdownMenuItem asChild>
                        <a href={getSupportUrl()}>
                            <LifeBuoy />
                            Help
                        </a>
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
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
    const { appName, documentTitle, isMobile, sidebarMode, setSidebarOpen } = useLayout();
    const auth = useAuth();
    const isGuest = useIsGuest();
    const { data: unreadCount = 0 } = useUnreadNotificationCount(auth.user?.id ?? '');

    useEffect(() => {
        const base = documentTitle ? `${documentTitle} — eigen|${appName}>` : `eigen|${appName}>`;
        document.title = unreadCount > 0 ? `(${unreadCount}) ${base}` : base;
    }, [appName, documentTitle, unreadCount]);

    const showBurger = isMobile && sidebarMode !== 'none';

    return (
        <header className="bg-app shrink-0">
            <div className="flex h-12 items-center">
                <div className="flex items-center pl-2 pr-4 shrink-0">
                    {showBurger && (
                        <Button
                            variant="ghost"
                            size="icon"
                            onClick={() => setSidebarOpen(true)}
                            className="mr-1 text-white hover:bg-primary/20 hover:text-white"
                        >
                            <Menu className="h-5 w-5" />
                            <span className="sr-only">Open menu</span>
                        </Button>
                    )}
                    {!isMobile && <AppSwitcher isGuest={isGuest} />}
                    <AppLogo appName={appName.toLowerCase()} />
                </div>

                <div className="flex-1 flex justify-center min-w-0">
                    {documentTitle && !isMobile && (
                        <span className="text-white/70 truncate max-w-[400px]">{documentTitle}</span>
                    )}
                </div>

                <div className="flex items-center gap-1 px-4 shrink-0">
                    <NotificationBell />
                    {isMobile && <AppSwitcher isGuest={isGuest} />}
                    {isGuest ? <GuestUserDropdown rootRoute={rootRoute} /> : <UserDropdown rootRoute={rootRoute} />}
                </div>
            </div>
        </header>
    );
}
