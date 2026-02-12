import {createRootRouteWithContext, Outlet} from '@tanstack/react-router'
import {AuthContextType} from "@workspace/lib/auth";
import {AppShell} from "@workspace/ui/components/layout/app-shell";
import {SpaceSidebar} from "../components/space/space-sidebar";

interface MyRouterContext {
    auth: AuthContextType;
}

export const Route = createRootRouteWithContext<MyRouterContext>()({
    component: () => (
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
    ),
});
