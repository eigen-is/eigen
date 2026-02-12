import {createRootRouteWithContext, Outlet} from '@tanstack/react-router'
import {AuthContextType} from "@workspace/lib/auth";
import {AppShell} from "@workspace/ui/components/layout/app-shell";
import {AdminSidebar} from "../components/admin/admin-sidebar";

interface MyRouterContext {
    auth: AuthContextType;
}

export const Route = createRootRouteWithContext<MyRouterContext>()({
    component: () => (
        <AppShell
            appName="admin"
            rootRoute={Route}
            sidebar={({condensed, isMobile, onClose}) => (
                <AdminSidebar condensed={condensed} isMobile={isMobile} onClose={onClose}/>
            )}
        >
            <div className="flex-1 overflow-auto">
                <Outlet/>
            </div>
        </AppShell>
    ),
});
