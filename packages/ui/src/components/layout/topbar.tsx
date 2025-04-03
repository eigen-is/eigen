import {useState} from "react";
import {Calendar, FileText, HardDrive, LayoutDashboard, Mail, Menu, Users} from "lucide-react";
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

// Meer generieke definitie voor de Route parameter
type NavigateFunction = (...args: any[]) => any;

interface TopbarProps {
    appName: string;
    rootRoute: {
        useNavigate: () => NavigateFunction;
    };
    showMobileMenu?: boolean;
    onMobileMenuClick?: () => void;
    isMobile?: boolean;
}

function UserDropdown({rootRoute, appName}: { rootRoute: TopbarProps['rootRoute'], appName: string }) {
    const router = useRouter();
    const navigate = rootRoute.useNavigate();
    const auth = useAuth();
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
                        <DialogTitle>Confirm Logout</DialogTitle>
                        <DialogDescription>
                            Are you sure you want to logout?
                        </DialogDescription>
                    </DialogHeader>
                    <DialogFooter className="flex justify-end gap-2">
                        <Button variant="outline" onClick={() => setLogoutDialogOpen(false)} className="mr-2">
                            Cancel
                        </Button>
                        <Button variant="default" onClick={handleLogout}>
                            OK
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>

            <DropdownMenu>
                <DropdownMenuTrigger asChild>
                    <Button variant="ghost"
                            className="relative h-8 w-8 rounded-full overflow-hidden p-0">
                        <UserAvatar
                            name={auth.user.name}
                            email={auth.user.email}
                            userId={auth.user.id}
                            size="sm"
                        />
                    </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent className="w-56" align="end" forceMount>
                    <DropdownMenuLabel className="font-normal">
                        <UserItem
                            name={auth.user.name}
                            email={auth.user.email}
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
                                    <span
                                        className={isActive ? "text-foreground font-medium" : "text-muted-foreground"}>{app.name}</span>
                                </a>
                            </DropdownMenuItem>
                        );
                    })}
                    <DropdownMenuSeparator/>
                    <DropdownMenuItem>
                        <a href={`${import.meta.env.VITE_APP_SPACE_URL}/user`} className={`flex items-center w-full gap-2`}>
                        Profile
                        </a>
                    </DropdownMenuItem>
                    <DropdownMenuItem>
                        <a href={`${import.meta.env.VITE_APP_SPACE_URL}/security/password`} className={`flex items-center w-full gap-2`}>
                        Settings
                        </a>
                    </DropdownMenuItem>
                    <DropdownMenuSeparator/>
                    <DropdownMenuItem onClick={() => setLogoutDialogOpen(true)}>
                        <span className={`flex items-center w-full gap-2`}>
                        Log out
                            </span>
                    </DropdownMenuItem>
                </DropdownMenuContent>
            </DropdownMenu>
        </>
        : null;
}

export function Topbar({appName, rootRoute, showMobileMenu, onMobileMenuClick, isMobile}: TopbarProps) {
    return (
        <header className="bg-app">
            <div className="flex h-12 items-center px-4">
                {isMobile && showMobileMenu && (
                    <Button
                        variant="ghost"
                        size="icon"
                        onClick={onMobileMenuClick}
                        className="mr-2 text-white hover:bg-primary/20 hover:text-white"
                    >
                        <Menu className="h-5 w-5"/>
                        <span className="sr-only">Open menu</span>
                    </Button>
                )}
                <AppLogo appName={appName.toLowerCase()}/>
                <div className="ml-auto flex items-center space-x-4">
                    <UserDropdown rootRoute={rootRoute} appName={appName}/>
                </div>
            </div>
        </header>
    );
}
