import {useEffect, useState} from "react";
import {Calendar, FileText, HardDrive, LayoutDashboard, Mail, Menu, StickyNote, Users} from "lucide-react";
import {useRouter} from "@tanstack/react-router";
import {Button} from "@workspace/ui/components/button";
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuLabel,
    DropdownMenuSeparator,
    DropdownMenuTrigger
} from "@workspace/ui/components/dropdown-menu";
import {useAuth} from "@workspace/lib/auth/auth-context.tsx";
import {Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,} from "../dialog";
import {apps} from "@workspace/lib/apps.ts";
import {UserItem} from "@workspace/ui/components/layout/user-item";
import {AppLogo} from "./app-logo";
import {UserAvatar} from "@workspace/ui";
import {useLayout} from "./layout-context";

// Meer generieke definitie voor de Route parameter
type NavigateFunction = (...args: any[]) => any;

interface TopbarProps {
    rootRoute: {
        useNavigate: () => NavigateFunction;
    };
}

function UserDropdown({rootRoute}: { rootRoute: TopbarProps['rootRoute'] }) {
    const router = useRouter();
    const navigate = rootRoute.useNavigate();
    const auth = useAuth();
    const {appName} = useLayout();
    const [logoutDialogOpen, setLogoutDialogOpen] = useState(false);

    const handleLogout = () => {
        auth.logout().then(() => {
            router.invalidate().finally(() => {
                // Gebruik navigate op de manier waarop TanStack Router het verwacht
                navigate({to: '/'});
                // Sluit de dialog
                setLogoutDialogOpen(false);
            })
        })
    }

    return auth.isAuthenticated ?
        <>
            <Dialog open={logoutDialogOpen} onOpenChange={setLogoutDialogOpen}>
                <DialogContent>
                    <DialogHeader>
                        <DialogTitle>Log out?</DialogTitle>
                        <DialogDescription>
                            Logging out will end your current session. You will be logged out of your account and will
                            need to log in again to continue.

                        </DialogDescription>
                    </DialogHeader>
                    <DialogFooter className="flex justify-end gap-2">
                        <Button variant="outline" onClick={() => setLogoutDialogOpen(false)} className="mr-2">
                            Go Back
                        </Button>
                        <Button variant="default" onClick={handleLogout}>
                            Log Out
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>

            <DropdownMenu>
                <DropdownMenuTrigger asChild>
                    <Button variant="ghost"
                            className="relative h-8 w-8 rounded-full overflow-hidden p-0">
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
                        <UserItem
                            name={auth.user?.name}
                            email={auth.user?.email}
                            className="p-0"
                        />
                    </DropdownMenuLabel>
                    <DropdownMenuSeparator/>
                    {apps.map(app => {
                        const isActive = app.name.toLowerCase() === appName.toLowerCase();
                        return (
                            <DropdownMenuItem key={app.name} className={isActive ? "bg-muted" : ""}>
                                <a href={app.href}
                                   className={`flex items-center w-full gap-2 ${isActive ? "font-medium" : ""}`}>
                                    {app.icon === 'layout-dashboard' && <LayoutDashboard className="h-4 w-4"/>}
                                    {app.icon === 'mail' && <Mail className="h-4 w-4"/>}
                                    {app.icon === 'calendar' && <Calendar className="h-4 w-4"/>}
                                    {app.icon === 'users' && <Users className="h-4 w-4"/>}
                                    {app.icon === 'hard-drive' && <HardDrive className="h-4 w-4"/>}
                                    {app.icon === 'file-text' && <FileText className="h-4 w-4"/>}
                                    {app.icon === 'sticky-note' && <StickyNote className="h-4 w-4"/>}
                                    <span
                                        className={isActive ? "text-foreground font-medium" : "text-muted-foreground"}>{app.name}</span>
                                </a>
                            </DropdownMenuItem>
                        );
                    })}
                    <DropdownMenuSeparator/>
                    <DropdownMenuItem>
                        <a href={`${import.meta.env.VITE_APP_SPACE_URL}/user`}
                           className={`flex items-center w-full`}>
                            Profile
                        </a>
                    </DropdownMenuItem>
                    <DropdownMenuItem>
                        <a href={`${import.meta.env.VITE_APP_SPACE_URL}/security/password`}
                           className={`flex items-center w-full`}>
                            Settings
                        </a>
                    </DropdownMenuItem>
                    <DropdownMenuSeparator/>
                    <DropdownMenuItem onClick={() => setLogoutDialogOpen(true)}>
                        <span className={`flex items-center w-full`}>
                        Log out
                            </span>
                    </DropdownMenuItem>
                </DropdownMenuContent>
            </DropdownMenu>
        </>
        : null;
}

export function Topbar({rootRoute}: TopbarProps) {
    const {appName, isMobile, isTablet, sidebarMode, setSidebarOpen, toolbars} = useLayout();

    useEffect(() => {
        document.title = `eigen|${appName}>`;
    }, [appName]);

    const showBurger = isMobile && sidebarMode !== 'none';

    const hasColumnToolbars = !isMobile && toolbars.length > 0;
    const sidebarWidth = sidebarMode === 'none' ? '0px' : isTablet ? '64px' : '256px';

    return (
        <header className="bg-app shrink-0">
            <div className="flex h-12 items-center">
                <div className="flex items-center px-4 shrink-0" style={hasColumnToolbars ? {width: sidebarWidth} : undefined}>
                    {showBurger && (
                        <Button
                            variant="ghost"
                            size="icon"
                            onClick={() => setSidebarOpen(true)}
                            className="mr-2 text-white hover:bg-primary/20 hover:text-white"
                        >
                            <Menu className="h-5 w-5"/>
                            <span className="sr-only">Open menu</span>
                        </Button>
                    )}
                    <AppLogo appName={appName.toLowerCase()}/>
                </div>

                {hasColumnToolbars ? (
                    <>
                        {toolbars.map(entry => (
                            <div
                                key={entry.columnId}
                                className="flex items-center px-4 h-full border-l border-white/10"
                                style={entry.width === 'flex' ? {flex: '1 1 auto', minWidth: 0} : {width: entry.width, flexShrink: 0}}
                            >
                                {entry.content}
                            </div>
                        ))}
                    </>
                ) : (
                    <div className="flex-1"/>
                )}

                <div className="flex items-center px-4 shrink-0">
                    <UserDropdown rootRoute={rootRoute}/>
                </div>
            </div>
        </header>
    );
}
