import {createRootRouteWithContext, Outlet} from '@tanstack/react-router'
import {TanStackRouterDevtools} from '@tanstack/react-router-devtools'
import {AuthContextType} from "@workspace/lib/auth";

interface MyRouterContext {
    auth: AuthContextType
}

export const Route = createRootRouteWithContext<MyRouterContext>()({
    beforeLoad: ({context}) => {
        // If the user is logged in and tries to visit the root URL,
        // redirect them to the drive app
        if (context.auth.isAuthenticated && window.location.pathname === '/') {
            // Use window.location for external redirects to other apps
            window.location.href = `${import.meta.env.VITE_APP_SPACE_URL}`;
            // Prevent the current page from loading
            return new Promise(() => {
            });
        }
    },
    component: () => (
        <>
            <div className="flex flex-col min-h-dvh">
                <Outlet/>
            </div>
            <TanStackRouterDevtools position="bottom-right"/>
        </>)
});
