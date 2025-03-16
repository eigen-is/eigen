import {UserIcon} from "lucide-react";
import {useRouter} from "@tanstack/react-router";
import {Route} from "@/routes/__root.tsx";
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuLabel,
    DropdownMenuSeparator,
    DropdownMenuTrigger
} from "@workspace/ui/components/dropdown-menu";
import {Button} from "@workspace/ui/components/button";
import {AppLogo} from "@workspace/ui/components/layout/app-logo";
import {useAuth} from "@workspace/lib/auth/auth-context.tsx";

function UserDropdown() {
    const router = useRouter();
    const navigate = Route.useNavigate();
    const auth = useAuth();

    const handleLogout = () => {
        if (window.confirm('Are you sure you want to logout?')) {
            auth.logout().then(() => {
                router.invalidate().finally(() => {
                    navigate({to: '/'});
                })
            })
        }
    }

    return auth.isAuthenticated ?
        <DropdownMenu>
            <DropdownMenuTrigger asChild>
                <Button variant="ghost"
                        className="relative h-8 w-8 rounded-full text-red-800 bg-white hover:bg-red-800 hover:text-black p-0">
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

export function Topbar({appName}: { appName: string }) {
    return (
        <header className="bg-app">
            <div className="flex h-12 items-center px-4">
                <AppLogo appName={appName.toLowerCase()}/>
                <div className="ml-auto flex items-center space-x-4">
                    <UserDropdown/>
                </div>
            </div>
        </header>
    );
}