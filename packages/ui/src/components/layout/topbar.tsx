import {UserIcon} from "lucide-react";
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

// Meer generieke definitie voor de Route parameter
type NavigateFunction = (...args: any[]) => any;

interface TopbarProps {
    appName: string;
    rootRoute: {
        useNavigate: () => NavigateFunction;
    };
}

function UserDropdown({ rootRoute }: { rootRoute: TopbarProps['rootRoute'] }) {
    const router = useRouter();
    const navigate = rootRoute.useNavigate();
    const auth = useAuth();

    const handleLogout = () => {
        if (window.confirm('Are you sure you want to logout?')) {
            auth.logout().then(() => {
                router.invalidate().finally(() => {
                    // Gebruik navigate op de manier waarop TanStack Router het verwacht
                    navigate({to: '/'});
                })
            })
        }
    }

    return auth.isAuthenticated ?
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
                <DropdownMenuItem>
                    Profile
                </DropdownMenuItem>
                <DropdownMenuItem>
                    Settings
                </DropdownMenuItem>
                <DropdownMenuSeparator/>
                <DropdownMenuItem onClick={() => handleLogout()}>
                    Log out
                </DropdownMenuItem>
            </DropdownMenuContent>
        </DropdownMenu>
        : null;
}

export function Topbar({ appName, rootRoute }: TopbarProps) {
    return (
        <header className="bg-app">
            <div className="flex h-12 items-center px-4">
                <AppLogo appName={appName.toLowerCase()}/>
                <div className="ml-auto flex items-center space-x-4">
                    <UserDropdown rootRoute={rootRoute} />
                </div>
            </div>
        </header>
    );
}
