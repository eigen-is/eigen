import {useEffect, useState} from "react";
import {LogOut, Menu, Palette, Settings, UserRound,} from "lucide-react";
import {useRouter} from "@tanstack/react-router";
import {Button} from "../../button.tsx";
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
} from "../../dropdown-menu.tsx";
import {useAuth} from "@workspace/lib/auth/auth-context.tsx";
import {Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,} from "../../dialog.tsx";
import {apps} from "@workspace/lib/apps.ts";
import {getSpacePasswordUrl, getSpaceProfileUrl} from "@workspace/lib/api.ts";
import {useSpaceSettings, useUpdateSpaceSettings} from "@workspace/lib/space";
import {UserItem} from "../user-item.tsx";
import {AppLogo} from "./app-logo.tsx";
import {UserAvatar} from "../user-avatar.tsx";
import {useLayout} from "./layout-context.tsx";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- TanStack Router's useNavigate has app-specific types
type NavigateFunction = (...args: any[]) => any;

type TopbarProps = {
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
    const {data: settings} = useSpaceSettings();
    const updateSettings = useUpdateSpaceSettings();

    const handleLogout = () => {
        auth.logout().then(() => {
            router.invalidate().finally(() => {
                navigate({to: '/'});
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
                        const Icon = app.icon;
                        return (
                            <DropdownMenuItem key={app.name} asChild className={isActive ? "bg-muted font-medium" : ""}>
                                <a href={app.href}>
                                    <Icon/>
                                    {app.name}
                                </a>
                            </DropdownMenuItem>
                        );
                    })}
                    <DropdownMenuSeparator/>
                    <DropdownMenuItem asChild>
                        <a href={getSpaceProfileUrl()}>
                            <UserRound/>
                            Profile
                        </a>
                    </DropdownMenuItem>
                    <DropdownMenuItem asChild>
                        <a href={getSpacePasswordUrl()}>
                            <Settings/>
                            Settings
                        </a>
                    </DropdownMenuItem>
                    <DropdownMenuSub>
                        <DropdownMenuSubTrigger>
                            <Palette/>
                            Theme
                        </DropdownMenuSubTrigger>
                        <DropdownMenuSubContent>
                            <DropdownMenuRadioGroup
                                value={settings?.theme ?? 'light'}
                                onValueChange={(v) => updateSettings.mutate({theme: v as 'light' | 'dark' | 'system'})}
                            >
                                <DropdownMenuRadioItem value="light">Light</DropdownMenuRadioItem>
                                <DropdownMenuRadioItem value="dark">Dark</DropdownMenuRadioItem>
                                <DropdownMenuRadioItem value="system">System</DropdownMenuRadioItem>
                            </DropdownMenuRadioGroup>
                        </DropdownMenuSubContent>
                    </DropdownMenuSub>
                    <DropdownMenuSeparator/>
                    <DropdownMenuItem onClick={() => setLogoutDialogOpen(true)}>
                        <LogOut/>
                        Log out
                    </DropdownMenuItem>
                </DropdownMenuContent>
            </DropdownMenu>
        </>
        : null;
}

export function Topbar({rootRoute}: TopbarProps) {
    const {appName, isMobile, sidebarMode, setSidebarOpen} = useLayout();

    useEffect(() => {
        document.title = `eigen|${appName}>`;
    }, [appName]);

    const showBurger = isMobile && sidebarMode !== 'none';

    return (
        <header className="bg-app shrink-0">
            <div className="flex h-12 items-center">
                <div className="flex items-center px-4 shrink-0">
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

                <div className="flex-1"/>

                <div className="flex items-center px-4 shrink-0">
                    <UserDropdown rootRoute={rootRoute}/>
                </div>
            </div>
        </header>
    );
}
