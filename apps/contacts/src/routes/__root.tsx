import {createRootRouteWithContext, Outlet} from '@tanstack/react-router'
import {TanStackRouterDevtools} from '@tanstack/react-router-devtools'
import {AuthContextType} from "@workspace/lib/auth/auth-context.tsx";
import {Topbar} from "@workspace/ui/components/layout/topbar";

const appName = 'contacts';

interface MyRouterContext {
    auth: AuthContextType
}

export const Route = createRootRouteWithContext<MyRouterContext>()({
    component: () => (
        <>
            <div className="flex flex-col h-dvh">
                <Topbar appName={appName} rootRoute={Route}/>
                <Outlet/>
            </div>
            <TanStackRouterDevtools position="bottom-right"/>
        </>)
});
