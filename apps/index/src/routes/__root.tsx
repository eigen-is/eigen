import {createRootRouteWithContext, Outlet} from '@tanstack/react-router'
import {TanStackRouterDevtools} from '@tanstack/react-router-devtools'
import {AuthContextType} from "@workspace/lib/auth/auth-context.tsx";
import {Topbar} from "../../components/layout/topbar.tsx";

const appName = 'space';

interface MyRouterContext {
    auth: AuthContextType
}

export const Route = createRootRouteWithContext<MyRouterContext>()({
    component: () => (
        <>
            <div className="flex flex-col h-screen">
                <Outlet/>
            </div>
            <TanStackRouterDevtools position="bottom-right"/>
        </>)
});
