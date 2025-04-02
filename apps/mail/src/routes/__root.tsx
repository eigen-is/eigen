import {createRootRouteWithContext, Outlet} from '@tanstack/react-router'
import {TanStackRouterDevtools} from '@tanstack/react-router-devtools'
import {AuthContextType} from "@workspace/lib/auth/auth-context.tsx";
import {Topbar} from "@workspace/ui/components/layout/topbar";
import {createContext, useState} from 'react';
import {useMediaQuery} from '@workspace/lib/mail';

const appName = 'mail';

// Create sidebar context to manage sidebar visibility
export const SidebarContext = createContext<{
  sidebarOpen: boolean;
  setSidebarOpen: (open: boolean) => void;
}>({
  sidebarOpen: false,
  setSidebarOpen: () => {},
});

interface MyRouterContext {
    auth: AuthContextType
}


export const Route = createRootRouteWithContext<MyRouterContext>()({
    component: () => {
        const [sidebarOpen, setSidebarOpen] = useState(false);
        const isMobile = useMediaQuery('(max-width: 768px)');
        
        return (
        <>
            <SidebarContext.Provider value={{ sidebarOpen, setSidebarOpen }}>
                <div className="flex flex-col h-dvh">
                    <Topbar 
                        appName={appName} 
                        rootRoute={Route}
                        showMobileMenu={isMobile}
                        onMobileMenuClick={() => setSidebarOpen(true)}
                        isMobile={isMobile}
                    />
                        <Outlet/>
                </div>
            </SidebarContext.Provider>
            <TanStackRouterDevtools position="bottom-right"/>
        </>)
    }
});
