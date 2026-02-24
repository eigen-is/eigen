import {createRootRouteWithContext, Outlet} from '@tanstack/react-router'
import {AuthContextType, useAuth} from "@workspace/lib/auth";
import {AppShell} from "@workspace/ui/components/layout/app-shell";
import {SpaceSidebar} from "../components/space/space-sidebar";

interface MyRouterContext {
    auth: AuthContextType;
}

function SpaceRoot() {
    const {user} = useAuth();

    if (!user) {
        return (
            <AppShell appName="space" rootRoute={Route}>
                <Outlet/>
            </AppShell>
        );
    }

    return (
        <AppShell
            appName="space"
            rootRoute={Route}
            sidebar={({condensed, isMobile, onClose}) => (
                <SpaceSidebar condensed={condensed} isMobile={isMobile} onClose={onClose}/>
            )}
        >
            <div className="flex-1 overflow-auto">
                <Outlet/>
            </div>
        </AppShell>
    );
}

export const Route = createRootRouteWithContext<MyRouterContext>()({
    component: SpaceRoot,
});
