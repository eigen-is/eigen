import {createRootRouteWithContext, Outlet} from '@tanstack/react-router'
import {AuthContextType} from "@workspace/lib/auth";
import {AppShell} from "@workspace/ui/components/layout/app-shell";
import {ContactsSidebar} from "../components/contacts/contacts-sidebar";

interface MyRouterContext {
    auth: AuthContextType;
}

export const Route = createRootRouteWithContext<MyRouterContext>()({
    component: () => (
        <AppShell
            appName="contacts"
            rootRoute={Route}
            sidebar={({condensed, isMobile, onClose}) => (
                <ContactsSidebar condensed={condensed} isMobile={isMobile} onClose={onClose}/>
            )}
        >
            <Outlet/>
        </AppShell>
    ),
});
