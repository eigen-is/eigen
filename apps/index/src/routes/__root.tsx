import {createRootRouteWithContext, Outlet} from '@tanstack/react-router'
import {TanStackRouterDevtools} from '@tanstack/react-router-devtools'
import {AuthContextType} from "@workspace/lib/auth/auth-context.tsx";

interface MyRouterContext {
    auth: AuthContextType
}

export const Route = createRootRouteWithContext<MyRouterContext>()({
    component: () => (
        <>
            <div className="flex flex-col h-dvh">
                <Outlet/>
            </div>
            <TanStackRouterDevtools position="bottom-right"/>
        </>)
});
