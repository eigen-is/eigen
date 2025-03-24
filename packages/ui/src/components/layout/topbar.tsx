import { useState } from "react";
import {UserIcon, Menu, LayoutDashboard, Mail, Calendar, Users, HardDrive, FileText} from "lucide-react";
import {useRouter} from "@tanstack/react-router";
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuLabel,
    DropdownMenuSeparator,
    DropdownMenuTrigger
} from "../dropdown-menu";
import {Button} from "../button";
import {AppLogo} from "./app-logo";
import {useAuth} from "@workspace/lib/auth/auth-context.tsx";
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from "../dialog";
import { apps } from "@workspace/lib/apps.ts";

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

function UserDropdown({ rootRoute }: { rootRoute: TopbarProps['rootRoute'] }) {
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
                            className="relative h-8 w-8 rounded-full app-text bg-white hover:bg-app hover:text-black p-0">
                        <UserIcon className="h-5 w-5"/>
                    </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent className="w-56" align="end" forceMount>
                    <DropdownMenuLabel className="font-normal">
                        <div className="flex flex-col space-y-1">
                            <p className="text-sm font-medium leading-none">User</p>
                            <p className="text-xs leading-none text-muted-foreground">
                                {auth.user.email}
                            </p>
                        </div>
                    </DropdownMenuLabel>
                    <DropdownMenuSeparator/>
                    {apps.map(app => (
                        <DropdownMenuItem key={app.name}>
                            <a href={app.href} className="flex items-center w-full gap-2">
                                {app.icon === 'layout-dashboard' && <LayoutDashboard className={`h-4 w-4 ${app.className}`} />}
                                {app.icon === 'mail' && <Mail className={`h-4 w-4 ${app.className}`} />}
                                {app.icon === 'calendar' && <Calendar className={`h-4 w-4 ${app.className}`} />}
                                {app.icon === 'users' && <Users className={`h-4 w-4 ${app.className}`} />}
                                {app.icon === 'hard-drive' && <HardDrive className={`h-4 w-4 ${app.className}`} />}
                                {app.icon === 'file-text' && <FileText className={`h-4 w-4 ${app.className}`} />}
                                <span className={app.className}>{app.name}</span>
                            </a>
                        </DropdownMenuItem>
                    ))}
                    <DropdownMenuSeparator/>
                    <DropdownMenuItem>
                        Profile
                    </DropdownMenuItem>
                    <DropdownMenuItem>
                        Settings
                    </DropdownMenuItem>
                    <DropdownMenuSeparator/>
                    <DropdownMenuItem onClick={() => setLogoutDialogOpen(true)}>
                        Log out
                    </DropdownMenuItem>
                </DropdownMenuContent>
            </DropdownMenu>
        </>
        : null;
}

export function Topbar({ appName, rootRoute, showMobileMenu, onMobileMenuClick, isMobile }: TopbarProps) {
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
                        <Menu className="h-5 w-5" />
                        <span className="sr-only">Open menu</span>
                    </Button>
                )}
                <AppLogo appName={appName.toLowerCase()}/>
                <div className="ml-auto flex items-center space-x-4">
                    <UserDropdown rootRoute={rootRoute} />
                </div>
            </div>
        </header>
    );
}
