import {createRootRouteWithContext, Outlet} from '@tanstack/react-router'
import {TanStackRouterDevtools} from '@tanstack/react-router-devtools'
import {AuthContextType} from "@workspace/lib/auth/auth-context.tsx";
import {Topbar} from "@workspace/ui/components/layout/topbar";

const appName = 'space';

interface MyRouterContext {
    auth: AuthContextType
}   


export const Route = createRootRouteWithContext<MyRouterContext>()({
    component: () => {
        const isMobile = false;
        
        return (
        <>
                <div className="flex flex-col h-dvh">
                    <Topbar 
                        appName={appName} 
                        rootRoute={Route}
                        showMobileMenu={isMobile}
                        onMobileMenuClick={() => {}}
                        isMobile={isMobile}
                    />
                        <Outlet/>
                </div>
            <TanStackRouterDevtools position="bottom-right"/>
        </>)
    }
});
