import {createRootRouteWithContext, Outlet} from '@tanstack/react-router'
import {TanStackRouterDevtools} from '@tanstack/react-router-devtools'
import {Topbar} from "@/components/layout/topbar";
import {AuthContextType} from "@/lib/auth/auth-context.tsx";

interface MyRouterContext {
    auth: AuthContextType
}

export const Route = createRootRouteWithContext<MyRouterContext>()({
    component: () => (
        <>
            <div className="flex flex-col h-screen">
                <Topbar/>
                <Outlet/>
            </div>
            <TanStackRouterDevtools position="bottom-right"/>
        </>)
});
