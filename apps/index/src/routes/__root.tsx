import {createRootRouteWithContext, Outlet} from '@tanstack/react-router'
import {TanStackRouterDevtools} from '@tanstack/react-router-devtools'
import {AuthContextType} from "@workspace/lib/auth";

interface MyRouterContext {
    auth: AuthContextType
}

export const Route = createRootRouteWithContext<MyRouterContext>()({
    beforeLoad: ({context}) => {
        // Als de gebruiker is ingelogd en probeert de root URL te bezoeken,
        // stuur ze dan naar de drive app
        if (context.auth.isAuthenticated && window.location.pathname === '/') {
            // Gebruik window.location voor externe redirects naar andere apps
            window.location.href = `${import.meta.env.VITE_APP_SPACE_URL}`;
            // Voorkom dat de huidige pagina laadt
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
