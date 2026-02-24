import {createRootRouteWithContext, Outlet} from '@tanstack/react-router'
import {AuthContextType} from "@workspace/lib/auth";
import {AppShell} from "@workspace/ui/components/layout/app-shell";

interface MyRouterContext {
    auth: AuthContextType
}

export const Route = createRootRouteWithContext<MyRouterContext>()({
    component: () => (
        <AppShell appName="calendar" rootRoute={Route} sidebarMode="none">
            <Outlet/>
        </AppShell>
    ),
});
