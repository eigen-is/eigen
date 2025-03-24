import {createRootRouteWithContext, Outlet} from '@tanstack/react-router'
import {TanStackRouterDevtools} from '@tanstack/react-router-devtools'
import {AuthContextType} from "@workspace/lib/auth/auth-context.tsx";
import {Topbar} from "@workspace/ui/components/layout/topbar";
import {useMediaQuery} from '../hooks/use-media-query';
import {createContext, useState} from 'react';

const appName = 'contacts';

// Create a context for sidebar state
export const SidebarContext = createContext<{
    sidebarOpen: boolean;
    setSidebarOpen: (open: boolean) => void;
}>({
    sidebarOpen: false,
    setSidebarOpen: () => {
    },
});

interface MyRouterContext {
    auth: AuthContextType;
}

export const Route = createRootRouteWithContext<MyRouterContext>()({
    component: RootComponent
});

function RootComponent() {
    const [sidebarOpen, setSidebarOpen] = useState(false);
    const isMobile = useMediaQuery('(max-width: 768px)');

    return (
        <SidebarContext.Provider value={{sidebarOpen, setSidebarOpen}}>
            <div className="flex flex-col h-screen">
                <Topbar
                    appName={appName}
                    rootRoute={Route}
                    showMobileMenu={true}
                    onMobileMenuClick={() => setSidebarOpen(true)}
                    isMobile={isMobile}
                />
                <div className="flex-1 overflow-hidden">
                    <Outlet/>
                </div>
            </div>
            <TanStackRouterDevtools position="bottom-right"/>
        </SidebarContext.Provider>
    );
}
